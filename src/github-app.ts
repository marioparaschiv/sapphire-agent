import { type KeyObject, sign } from 'node:crypto';
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema, SchemaGetter } from 'effect';
import { HttpClient, type HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { type CallError, callTimeouts, Permanent, Transient, transportFailure, withCallPolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';

const AppJson = Schema.Struct({ slug: Schema.String });

const Installation = Schema.Struct({ id: Schema.Int });

const AccessToken = Schema.Struct({ token: Schema.String, expiresAt: Schema.String }).pipe(Schema.encodeKeys({ expiresAt: 'expires_at' }));

const ErrorJson = Schema.Struct({ message: Schema.String });

// One attempt to deliver a webhook event. A redelivery is a new attempt with the event's `guid`.
export const Delivery = Schema.Struct({
	id: Schema.Int,
	guid: Schema.String,
	// In ms.
	deliveredAt: Schema.String.pipe(
		Schema.decodeTo(Schema.Int, { decode: SchemaGetter.transform(Date.parse), encode: SchemaGetter.transform((millis) => new Date(millis).toISOString()) }),
	),
	statusCode: Schema.Int,
}).pipe(
	Schema.encodeKeys({ deliveredAt: 'delivered_at', statusCode: 'status_code' }),
);

export type Delivery = typeof Delivery.Type;

export type DeliveryPage = { readonly deliveries: ReadonlyArray<Delivery>; readonly next: Option.Option<string> };

// GitHub's maximum.
const deliveriesPerPage = 100;

// The `cursor` of the `rel="next"` URL in a Link header.
const nextCursor = (link: string | undefined) =>
	Option.fromNullishOr(/<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1]).pipe(Option.flatMap((url) => Option.fromNullishOr(new URL(url).searchParams.get('cursor'))));

// A token is minted again this long before GitHub expires it, so a write that starts with it has time to finish.
const tokenRefreshMargin = Duration.minutes(5);

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// The JWT that authenticates as the App. GitHub refuses an `iat` in its future and an `exp` more than 10 min ahead, so
// `iat` is backdated 60 s against clock drift and `exp` is 10 min after it.
const appJwt = (appId: number, key: KeyObject, nowMillis: number) => {
	const now = Math.floor(nowMillis / 1000);
	const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iat: now - 60, exp: now + 540, iss: appId })}`;

	return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
};

export class GitHubApp extends Context.Service<
	GitHubApp,
	{
		// `<slug>[bot]`, the login GitHub gives the App's comments.
		readonly login: string;
		// A token acting as the App on the installation that covers the repo (`owner/name`). Each installation's token is
		// reused until shortly before it expires.
		readonly installationToken: (repo: string) => Effect.Effect<Redacted.Redacted<string>, CallError>;
		// A page of the App's webhook deliveries, newest first: the first page, or the one at `cursor`.
		readonly deliveries: (cursor: Option.Option<string>) => Effect.Effect<DeliveryPage, CallError>;
		// Asks GitHub to send the delivery again, as a new attempt with the same `guid`.
		readonly redeliver: (id: number) => Effect.Effect<void, CallError>;
	}
>()('herdr-linear/GitHubApp') {
	// Reads the App's slug from GitHub, so it fails to build when the App id, key or GitHub is wrong.
	static readonly layer = (apiUrl = 'https://api.github.com') =>
		Layer.effect(
			GitHubApp,
			Effect.gen(function* () {
				const { bot, appPrivateKey } = yield* AppConfig;
				const client = (yield* HttpClient.HttpClient).pipe(
					HttpClient.mapRequest((request) =>
						request.pipe(HttpClientRequest.prependUrl(apiUrl), HttpClientRequest.acceptJson, HttpClientRequest.setHeader('x-github-api-version', '2022-11-28')),
					),
				);
				const tokens = new Map<number, { readonly token: Redacted.Redacted<string>; readonly refreshAt: number }>();

				const call = <A>(
					request: HttpClientRequest.HttpClientRequest,
					read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>,
				) =>
					Effect.gen(function* () {
						const where = `${request.method} ${request.url}`;
						const jwt = appJwt(bot.app.id, appPrivateKey, yield* Clock.currentTimeMillis);
						const response = yield* client.execute(HttpClientRequest.bearerToken(request, jwt)).pipe(Effect.mapError(transportFailure('GitHub')));
						const { status } = response;

						if (status === 429 || status >= 500) {
							return yield* new Transient({ message: `GitHub answered HTTP ${status} to ${where}` });
						}

						if (status < 200 || status >= 300) {
							const body = yield* HttpClientResponse.schemaBodyJson(ErrorJson)(response).pipe(Effect.option);

							return yield* new Permanent({ message: `GitHub answered HTTP ${status} to ${where}: ${Option.match(body, { onNone: () => 'no error message', onSome: ({ message }) => message })}` });
						}

						return yield* read(response).pipe(
							Effect.catchTags({
								HttpClientError: (error) => Effect.fail(transportFailure('GitHub')(error)),
								SchemaError: (error) => Effect.fail(new Permanent({ message: `GitHub answered ${where} with unexpected data: ${error.message}`, cause: error })),
							}),
						);
					}).pipe(withCallPolicy(callTimeouts.gh));

				const { slug } = yield* call(HttpClientRequest.get('/app'), HttpClientResponse.schemaBodyJson(AppJson));

				return GitHubApp.of({
					login: `${slug}[bot]`,

					installationToken: (repo) =>
						Effect.gen(function* () {
							const { id } = yield* call(HttpClientRequest.get(`/repos/${repo}/installation`), HttpClientResponse.schemaBodyJson(Installation));
							const cached = tokens.get(id);

							if (cached && (yield* Clock.currentTimeMillis) < cached.refreshAt) {
								return cached.token;
							}

							const { token, expiresAt } = yield* call(HttpClientRequest.post(`/app/installations/${id}/access_tokens`), HttpClientResponse.schemaBodyJson(AccessToken));
							const minted = { token: Redacted.make(token), refreshAt: Date.parse(expiresAt) - Duration.toMillis(tokenRefreshMargin) };

							tokens.set(id, minted);

							return minted.token;
						}),

					deliveries: (cursor) =>
						call(HttpClientRequest.get('/app/hook/deliveries', { urlParams: { per_page: deliveriesPerPage, ...Option.match(cursor, { onNone: () => ({}), onSome: (at) => ({ cursor: at }) }) } }), (response) =>
							HttpClientResponse.schemaBodyJson(Schema.Array(Delivery))(response).pipe(Effect.map((deliveries) => ({ deliveries, next: nextCursor(response.headers.link) }))),
						),

					redeliver: (id) => call(HttpClientRequest.post(`/app/hook/deliveries/${id}/attempts`), () => Effect.void),
				});
			}),
		);
}
