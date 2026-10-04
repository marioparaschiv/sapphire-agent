import { Context, Effect, Layer, Option, Redacted, Schema, SchemaGetter, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { GitHubApp } from './github-app.ts';
import { hasMarker, type MarkedComment, type Marker } from './markers.ts';
import type { ResultFile } from './result-file.ts';

export const PullRequestState = Schema.Literals(['OPEN', 'CLOSED', 'MERGED']);

export type PullRequestState = typeof PullRequestState.Type;

export const PullRequest = Schema.Struct({
	number: Schema.Int,
	url: Schema.String,
	state: PullRequestState,
	author: Schema.Struct({ login: Schema.String }),
});

export type PullRequest = typeof PullRequest.Type;

// A page of a GitHub connection, enough to look for a marker.
export const Bodies = Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(Schema.Struct({ body: Schema.String })) });

export type Bodies = typeof Bodies.Type;

// An unread notification of the bot's, about an issue or PR. `lastReadAt` is when the bot last read the thread.
export type Notification = { readonly threadId: string; readonly repo: string; readonly number: number; readonly lastReadAt: Option.Option<number> };

const NotificationJson = Schema.Struct({
	id: Schema.String,
	lastReadAt: Schema.NullOr(Schema.String),
	subject: Schema.Struct({ type: Schema.String, url: Schema.NullOr(Schema.String) }),
	repository: Schema.Struct({ fullName: Schema.String }).pipe(Schema.encodeKeys({ fullName: 'full_name' })),
}).pipe(Schema.encodeKeys({ lastReadAt: 'last_read_at' }));

// GraphQL gives an App's comments the App's slug as the login, where REST and webhooks give `<slug>[bot]`.
const Author = Schema.Struct({ __typename: Schema.String, login: Schema.String }).pipe(
	Schema.decodeTo(Schema.Struct({ login: Schema.String }), {
		decode: SchemaGetter.transform(({ __typename, login }) => ({ login: __typename === 'Bot' ? `${login}[bot]` : login })),
		encode: SchemaGetter.forbiddenEncoding,
	}),
);

// A comment on an issue or PR, a review, or a review comment. The author is null for a deleted account.
const GitHubComment = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	body: Schema.String,
	createdAt: Schema.String,
	author: Schema.NullOr(Author),
});

export type GitHubComment = typeof GitHubComment.Type;

const Conversation = Schema.Struct({
	comments: Schema.Struct({ nodes: Schema.Array(GitHubComment) }),
	reviews: Schema.optionalKey(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ ...GitHubComment.fields, comments: Schema.Struct({ nodes: Schema.Array(GitHubComment) }) })) })),
});

export type Conversation = typeof Conversation.Type;

const commentFields = 'id url body createdAt author { __typename login }';

export type Flags = ResultFile['flags'];

// Linear shows a GitHub comment carrying this block as written by Claude. The agent and the user share one GitHub
// account, so it is the only way to tell the agent's comments from the user's.
export const ON_BEHALF_OF_CLAUDE = '<!-- linear:extension {"version":1,"plugins":[{"plugin":"onBehalfOf","agent":"claude"}]} -->';

export const asClaude = (body: string) => `${body}\n\n${ON_BEHALF_OF_CLAUDE}`;

export const isClaude = (body: string) => body.includes(ON_BEHALF_OF_CLAUDE);

// `@<login>` as a whole word, so neither `@<login>x` nor an email address like `a@<login>` counts. GitHub logins are
// case-insensitive.
export const mentions = (login: string, body: string) => new RegExp(`(?<![\\w@-])@${RegExp.escape(login)}(?![\\w-])`, 'i').test(body);

// GitHub caps a connection page at 100 nodes.
export const maxNodes = 100;

// How many unread notifications one tick reads.
export const notificationsPerTick = 50;

// Every comment of an issue or PR, flattened: its comments, then each review and the review's comments.
export const conversationComments = (conversation: Conversation): ReadonlyArray<GitHubComment> => [
	...conversation.comments.nodes,
	...(conversation.reviews?.nodes ?? []).flatMap(({ comments, ...review }) => [review, ...comments.nodes]),
];

// The open PR for the branch if there is one, else a merged one, else a closed one.
export const preferredPullRequest = (pullRequests: ReadonlyArray<PullRequest>) =>
	Option.fromUndefinedOr(pullRequests.find((pr) => pr.state === 'OPEN') ?? pullRequests.find((pr) => pr.state === 'MERGED') ?? pullRequests[0]);

// The API URL of the thread's subject ends in the issue or PR number.
const notificationOf = ({ id, lastReadAt, subject, repository }: typeof NotificationJson.Type): Option.Option<Notification> => {
	const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec(subject.url ?? '')?.[1]);

	if (!Number.isInteger(number)) {
		return Option.none();
	}

	return Option.some({ threadId: id, repo: repository.fullName, number, lastReadAt: Option.map(Option.fromNullishOr(lastReadAt), Date.parse) });
};

// `bodies` holds the latest nodes; past the cap, a missing marker could be on an earlier page.
export const containsMarker = (bodies: Bodies, marker: Marker, where: string): Effect.Effect<boolean, Permanent> => {
	if (bodies.nodes.some(({ body }) => hasMarker(body, marker))) {
		return Effect.succeed(true);
	}

	if (bodies.totalCount > maxNodes) {
		return Effect.fail(new Permanent({ message: `${where} has ${bodies.totalCount} entries, over the ${maxNodes} one query reads` }));
	}

	return Effect.succeed(false);
};

const transientFailure = /error connecting to|connection (reset|refused)|timeout|timed out|unexpected EOF|HTTP 5\d\d|HTTP 429|rate limit/i;

// gh prints e.g. `HTTP 502: Bad Gateway (https://api.github.com/graphql)` or `error connecting to api.github.com`.
export const classifyGhFailure = (command: string, exitCode: number, stderr: string): CallError => {
	const message = `${command} exited with ${exitCode}: ${stderr.trim()}`;

	return transientFailure.test(stderr) ? new Transient({ message }) : new Permanent({ message });
};

export class GitHub extends Context.Service<
	GitHub,
	{
		// See preferredPullRequest.
		readonly findPullRequest: (repo: string, branch: string) => Effect.Effect<Option.Option<PullRequest>, CallError>;
		readonly postSummary: (repo: string, number: number, comment: MarkedComment) => Effect.Effect<void, CallError>;
		// One COMMENT review holding every flag as an inline comment on the PR's new code.
		readonly postFlagsReview: (repo: string, number: number, comment: MarkedComment, flags: Flags) => Effect.Effect<void, CallError>;
		readonly replyToThread: (threadId: string, comment: MarkedComment) => Effect.Effect<void, CallError>;
		readonly resolveThread: (threadId: string) => Effect.Effect<void, CallError>;
		// The bot's newest unread notifications about issues and PRs it takes part in or was mentioned on, at most
		// notificationsPerTick. The reason is left out: it can change with later comments on the thread.
		readonly notifications: Effect.Effect<ReadonlyArray<Notification>, CallError>;
		// Marks the bot's notification thread read; a thread read already stays read.
		readonly markNotificationRead: (threadId: string) => Effect.Effect<void, CallError>;
		// The newest comments of the issue or PR (see conversationComments), up to maxNodes of each kind.
		readonly conversation: (repo: string, number: number) => Effect.Effect<ReadonlyArray<GitHubComment>, CallError>;
		// A comment on the issue or PR as the GitHub App.
		readonly postAsBot: (repo: string, number: number, comment: MarkedComment) => Effect.Effect<void, CallError>;
	}
>()('herdr-linear/GitHub') {
	static readonly layer = Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { bot } = yield* AppConfig;
			const app = yield* GitHubApp;
			const encoder = new TextEncoder();
			const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString);

			// The user's account is gh's default login. `env` switches it: to the bot user's gh config dir, or to a GitHub App
			// installation token.
			const asBotUser = { GH_CONFIG_DIR: bot.ghConfigDirectory };

			const run = (args: ReadonlyArray<string>, input: string, env?: Record<string, string>) => {
				const command = `gh ${args.join(' ')}`;
				const options = env ? { env, extendEnv: true } : {};

				return Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(ChildProcess.make('gh', args, { stdin: Stream.make(encoder.encode(input)), ...options }));
						const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						if (exitCode !== 0) {
							return yield* Effect.fail(classifyGhFailure(command, exitCode, stderr));
						}

						return stdout;
					}),
				).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new Permanent({ message: `${command}: ${error.message}`, cause: error }))));
			};

			const gh = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>, input = '', env?: Record<string, string>) =>
				run(args, input, env).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
					Effect.catchTag('SchemaError', (error) => Effect.fail(new Permanent({ message: `gh ${args.join(' ')}: ${error.message}`, cause: error }))),
				);

			// gh exits non-zero when the response carries GraphQL errors.
			const graphql = <A>(schema: Schema.Decoder<A>, query: string, variables: Record<string, unknown>) =>
				gh(Schema.Struct({ data: schema }), ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })).pipe(Effect.map(({ data }) => data));

			const post = (endpoint: string, body: Record<string, unknown>, env?: Record<string, string>) =>
				gh(Schema.Struct({ id: Schema.Int }), ['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body), env).pipe(Effect.asVoid);

			const ownerAndName = (repo: string) => {
				const [owner, name] = repo.split('/');

				return { owner, name };
			};

			const pullRequestBodies = (repo: string, number: number, connection: 'comments' | 'reviews') =>
				graphql(
					Schema.Struct({ repository: Schema.Struct({ pullRequest: Schema.Struct({ [connection]: Bodies }) }) }),
					`query PullRequestBodies($owner: String!, $name: String!, $number: Int!) {
						repository(owner: $owner, name: $name) {
							pullRequest(number: $number) { ${connection}(last: ${maxNodes}) { totalCount nodes { body } } }
						}
					}`,
					{ ...ownerAndName(repo), number },
				).pipe(Effect.map(({ repository }) => repository.pullRequest[connection]));

			const reviewThread = (threadId: string) =>
				graphql(
					Schema.Struct({ node: Schema.NullOr(Schema.Struct({ isResolved: Schema.Boolean, comments: Bodies })) }),
					`query ReviewThread($threadId: ID!) {
						node(id: $threadId) { ... on PullRequestReviewThread { isResolved comments(last: ${maxNodes}) { totalCount nodes { body } } } }
					}`,
					{ threadId },
				).pipe(
					Effect.flatMap(({ node }) =>
						node === null ? Effect.fail(new Permanent({ message: `no review thread ${threadId}` })) : Effect.succeed(node),
					),
				);

			const conversationBodies = (repo: string, number: number) =>
				graphql(
					Schema.Struct({ repository: Schema.Struct({ issueOrPullRequest: Schema.NullOr(Schema.Struct({ comments: Bodies })) }) }),
					`query ConversationBodies($owner: String!, $name: String!, $number: Int!) {
						repository(owner: $owner, name: $name) {
							issueOrPullRequest(number: $number) {
								... on Issue { comments(last: ${maxNodes}) { totalCount nodes { body } } }
								... on PullRequest { comments(last: ${maxNodes}) { totalCount nodes { body } } }
							}
						}
					}`,
					{ ...ownerAndName(repo), number },
				).pipe(
					Effect.flatMap(({ repository }) =>
						repository.issueOrPullRequest === null
							? Effect.fail(new Permanent({ message: `${repo}#${number} is no issue or PR` }))
							: Effect.succeed(repository.issueOrPullRequest.comments),
					),
				);

			// Each method is one unit under the call policy, so a retry repeats the marker or resolved check before
			// writing again.
			const withPolicy = withCallPolicy(callTimeouts.gh);

			const unlessMarked = (bodies: Effect.Effect<Bodies, CallError>, marker: Marker, where: string, write: Effect.Effect<void, CallError>) =>
				bodies.pipe(
					Effect.flatMap((found) => containsMarker(found, marker, where)),
					Effect.flatMap((marked) => (marked ? Effect.void : write)),
					withPolicy,
				);

			return GitHub.of({
				findPullRequest: (repo, branch) =>
					gh(Schema.Array(PullRequest), ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,author']).pipe(
						Effect.map(preferredPullRequest),
						withPolicy,
					),

				postSummary: (repo, number, { marker, body }) =>
					unlessMarked(
						pullRequestBodies(repo, number, 'comments'),
						marker,
						`${repo}#${number} comments`,
						post(`repos/${repo}/issues/${number}/comments`, { body: asClaude(body) }),
					),

				postFlagsReview: (repo, number, { marker, body }, flags) =>
					unlessMarked(
						pullRequestBodies(repo, number, 'reviews'),
						marker,
						`${repo}#${number} reviews`,
						post(`repos/${repo}/pulls/${number}/reviews`, {
							event: 'COMMENT',
							body: asClaude(body),
							comments: flags.map(({ path, line, body }) => ({ path, line, side: 'RIGHT', body: asClaude(body) })),
						}),
					),

				replyToThread: (threadId, { marker, body }) =>
					unlessMarked(
						Effect.map(reviewThread(threadId), ({ comments }) => comments),
						marker,
						`review thread ${threadId}`,
						graphql(
							Schema.Struct({ addPullRequestReviewThreadReply: Schema.Struct({ comment: Schema.Struct({ id: Schema.String }) }) }),
							`mutation ReplyToThread($threadId: ID!, $body: String!) {
								addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
							}`,
							{ threadId, body: asClaude(body) },
						).pipe(Effect.asVoid),
					),

				resolveThread: (threadId) =>
					reviewThread(threadId).pipe(
						Effect.flatMap(({ isResolved }) =>
							isResolved
								? Effect.void
								: graphql(
										Schema.Struct({ resolveReviewThread: Schema.Struct({ thread: Schema.Struct({ isResolved: Schema.Literal(true) }) }) }),
										`mutation ResolveThread($threadId: ID!) {
											resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
										}`,
										{ threadId },
									).pipe(Effect.asVoid),
						),
						withPolicy,
					),

				notifications: gh(Schema.Array(NotificationJson), ['api', `notifications?participating=true&per_page=${notificationsPerTick}`], '', asBotUser).pipe(
					Effect.map((found) => found.flatMap((notification) => Option.toArray(notificationOf(notification)))),
					withPolicy,
				),

				markNotificationRead: (threadId) => run(['api', '--method', 'PATCH', `notifications/threads/${threadId}`], '', asBotUser).pipe(Effect.asVoid, withPolicy),

				conversation: (repo, number) =>
					graphql(
						Schema.Struct({ repository: Schema.Struct({ issueOrPullRequest: Schema.NullOr(Conversation) }) }),
						`query Conversation($owner: String!, $name: String!, $number: Int!) {
							repository(owner: $owner, name: $name) {
								issueOrPullRequest(number: $number) {
									... on Issue { comments(last: ${maxNodes}) { nodes { ${commentFields} } } }
									... on PullRequest {
										comments(last: ${maxNodes}) { nodes { ${commentFields} } }
										reviews(last: ${maxNodes}) { nodes { ${commentFields} comments(first: ${maxNodes}) { nodes { ${commentFields} } } } }
									}
								}
							}
						}`,
						{ ...ownerAndName(repo), number },
					).pipe(
						Effect.flatMap(({ repository }) =>
							repository.issueOrPullRequest === null
								? Effect.fail(new Permanent({ message: `${repo}#${number} is no issue or PR` }))
								: Effect.succeed(conversationComments(repository.issueOrPullRequest)),
						),
						withPolicy,
					),

				postAsBot: (repo, number, { marker, body }) =>
					Effect.flatMap(app.installationToken(repo), (token) =>
						unlessMarked(conversationBodies(repo, number), marker, `${repo}#${number} comments`, post(`repos/${repo}/issues/${number}/comments`, { body }, { GH_TOKEN: Redacted.value(token) })),
					),
			});
		}),
	);
}
