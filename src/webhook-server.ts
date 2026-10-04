import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { Cause, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { AppConfig } from './config.ts';
import { type Comment, makeRecordMention } from './mentions.ts';
import { Reconciler } from './reconciler.ts';

const Repository = Schema.Struct({ fullName: Schema.String }).pipe(Schema.encodeKeys({ fullName: 'full_name' }));

const Numbered = Schema.Struct({ number: Schema.Int });

const commentFields = { nodeId: Schema.String, htmlUrl: Schema.String, body: Schema.String, user: Schema.Struct({ login: Schema.String }) };

const commentKeys = { nodeId: 'node_id', htmlUrl: 'html_url' } as const;

const GitHubComment = Schema.Struct(commentFields).pipe(Schema.encodeKeys(commentKeys));

// A review submitted without a body has a null one.
const Review = Schema.Struct({ ...commentFields, body: Schema.NullOr(Schema.String) }).pipe(Schema.encodeKeys(commentKeys));

const Action = Schema.fromJsonString(Schema.Struct({ action: Schema.String }));

const commentOf = (repository: typeof Repository.Type, number: number, { nodeId, htmlUrl, body, user }: typeof GitHubComment.Type): Comment => ({
	commentId: nodeId,
	url: htmlUrl,
	author: user.login,
	body,
	repo: repository.fullName,
	number,
});

const handledEvent = <A>(action: string, payload: Schema.Decoder<A>, toComment: (decoded: A) => Comment) => ({
	action,
	comment: (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(payload))(text).pipe(Effect.map(toComment)),
});

// The deliveries that can carry a new mention, by X-GitHub-Event.
const handledEvents: Record<string, ReturnType<typeof handledEvent>> = {
	issue_comment: handledEvent('created', Schema.Struct({ issue: Numbered, comment: GitHubComment, repository: Repository }), ({ issue, comment, repository }) =>
		commentOf(repository, issue.number, comment),
	),
	pull_request_review_comment: handledEvent(
		'created',
		Schema.Struct({ pullRequest: Numbered, comment: GitHubComment, repository: Repository }).pipe(Schema.encodeKeys({ pullRequest: 'pull_request' })),
		({ pullRequest, comment, repository }) => commentOf(repository, pullRequest.number, comment),
	),
	pull_request_review: handledEvent(
		'submitted',
		Schema.Struct({ pullRequest: Numbered, review: Review, repository: Repository }).pipe(Schema.encodeKeys({ pullRequest: 'pull_request' })),
		({ pullRequest, review, repository }) => commentOf(repository, pullRequest.number, { ...review, body: review.body ?? '' }),
	),
};

// GitHub signs the raw body with the webhook secret: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>`.
const isSigned = (secret: Redacted.Redacted<string>, body: Uint8Array, header: string | undefined) => {
	if (header === undefined || !header.startsWith('sha256=')) {
		return false;
	}

	const expected = createHmac('sha256', Redacted.value(secret)).update(body).digest();
	const given = Buffer.from(header.slice('sha256='.length), 'hex');

	return given.length === expected.length && timingSafeEqual(given, expected);
};

const respond = (status: number) => HttpServerResponse.empty({ status });

// GitHub App webhook deliveries, on 127.0.0.1:bot.app.webhookPort while the service runs. A delivery that brings a
// new comment mentioning the bot is recorded as a command (see makeRecordMention) and wakes the reconciler, which starts
// it. The delivery is answered 2xx only once the command is in the journal, so a failed one shows as failed in the App's
// delivery log and can be redelivered; recording is idempotent on the comment, so a redelivery never starts a second run.
export class WebhookServer extends Context.Service<
	WebhookServer,
	{
		// Where it listens, e.g. `http://127.0.0.1:3790`.
		readonly url: string;
	}
>()('herdr-linear/WebhookServer') {
	static readonly layer = Layer.effect(
		WebhookServer,
		Effect.gen(function* () {
			const { bot, webhookSecret } = yield* AppConfig;
			const reconciler = yield* Reconciler;
			const recordMention = yield* makeRecordMention;

			const handle = (request: HttpServerRequest.HttpServerRequest) =>
				Effect.gen(function* () {
					const body = new Uint8Array(yield* request.arrayBuffer);
	
					if (!isSigned(webhookSecret, body, request.headers['x-hub-signature-256'])) {
						yield* Effect.logWarning('refused a delivery without a valid signature');
	
						return respond(401);
					}
	
					const text = new TextDecoder().decode(body);
					const event = handledEvents[request.headers['x-github-event'] ?? ''];
	
					if (event === undefined || (yield* Schema.decodeUnknownEffect(Action)(text)).action !== event.action) {
						return respond(204);
					}
	
					if (yield* recordMention(yield* event.comment(text))) {
						yield* reconciler.wake;
					}
	
					return respond(204);
				}).pipe(
					Effect.catchTag('SchemaError', (error) => Effect.logWarning('refused a delivery that does not match its event', error).pipe(Effect.as(respond(400)))),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError('cannot handle the delivery', cause).pipe(Effect.as(respond(500))),
					),
					Effect.annotateLogs({ delivery: request.headers['x-github-delivery'] ?? 'unknown' }),
				);

			const server = yield* NodeHttpServer.make(createServer, { host: '127.0.0.1', port: bot.app.webhookPort });
			const url = HttpServer.formatAddress(server.address);

			yield* server.serve(HttpServerRequest.HttpServerRequest.use(handle));
			yield* Effect.log(`listening for GitHub webhook deliveries on ${url}`);

			return WebhookServer.of({ url });
		}),
	);
}
