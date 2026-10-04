import { Context, Effect, Layer, Option, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';
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

export const ReviewThread = Schema.Struct({
	id: Schema.String,
	isResolved: Schema.Boolean,
	comments: Schema.Struct({
		nodes: Schema.Array(Schema.Struct({ body: Schema.String, pullRequestReview: Schema.NullOr(Schema.Struct({ body: Schema.String })) })),
	}),
});

export type ReviewThread = typeof ReviewThread.Type;

// A page of a GitHub connection, enough to look for a marker.
export const Bodies = Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(Schema.Struct({ body: Schema.String })) });

export type Bodies = typeof Bodies.Type;

// The author is null for a deleted account.
const PullRequestComments = Schema.Struct({
	totalCount: Schema.Int,
	nodes: Schema.Array(Schema.Struct({ body: Schema.String, author: Schema.NullOr(Schema.Struct({ login: Schema.String })) })),
});

type PullRequestComments = typeof PullRequestComments.Type;

const PullRequestThreads = Schema.Struct({
	url: Schema.String,
	comments: PullRequestComments,
	reviewThreads: Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(ReviewThread) }),
});

export type PullRequestThreads = typeof PullRequestThreads.Type;

export type PendingThreads = { readonly url: string; readonly threadIds: ReadonlyArray<string> };

export type Flags = ResultFile['flags'];

type Account = 'user' | 'bot';

// Linear shows a GitHub comment carrying this block as written by Claude. The agent and the user share one GitHub
// account, so it is the only way to tell the agent's comments from the user's.
export const ON_BEHALF_OF_CLAUDE = '<!-- linear:extension {"version":1,"plugins":[{"plugin":"onBehalfOf","agent":"claude"}]} -->';

export const asClaude = (body: string) => `${body}\n\n${ON_BEHALF_OF_CLAUDE}`;

const isClaude = (body: string) => body.includes(ON_BEHALF_OF_CLAUDE);

// `@<login>` as a whole word, so neither `@<login>x` nor an email address like `a@<login>` counts. GitHub logins are
// case-insensitive.
const mentionOf = (login: string) => new RegExp(`(?<![\\w@-])@${RegExp.escape(login)}(?![\\w-])`, 'i');

// GitHub caps a connection page at 100 nodes.
export const maxNodes = 100;

// Unresolved, and the user's latest comment mentions the bot, in its body or in the body of the review it was
// submitted with. Comments carrying the onBehalfOf block are the agent's own and never count.
const isPending = (mention: RegExp) => (thread: ReviewThread) => {
	const latest = thread.comments.nodes.findLast((comment) => !isClaude(comment.body));

	return !thread.isResolved && !!latest && (mention.test(latest.body) || mention.test(latest.pullRequestReview?.body ?? ''));
};

// A user's PR comment mentions the bot and no comment of the bot's came after it, so every unresolved thread is
// pending. The bot comments when the follow-up starts, so a request written while that follow-up runs stays pending.
const reviewRequested = (botLogin: string, mention: RegExp, { nodes }: PullRequestComments) => {
	const isBot = ({ author }: PullRequestComments['nodes'][number]) => author?.login.toLowerCase() === botLogin.toLowerCase();

	return nodes.slice(nodes.findLastIndex(isBot) + 1).some(({ body }) => !isClaude(body) && mention.test(body));
};

// The open PR for the branch if there is one, else a merged one, else a closed one.
export const preferredPullRequest = (pullRequests: ReadonlyArray<PullRequest>) =>
	Option.fromUndefinedOr(pullRequests.find((pr) => pr.state === 'OPEN') ?? pullRequests.find((pr) => pr.state === 'MERGED') ?? pullRequests[0]);

export const pendingOf = (botLogin: string, pullRequest: PullRequestThreads): Effect.Effect<PendingThreads, Permanent> => {
	const { url, comments, reviewThreads } = pullRequest;
	const mention = mentionOf(botLogin);

	// A truncated page could hide a pending thread.
	if (reviewThreads.totalCount > maxNodes) {
		return Effect.fail(new Permanent({ message: `${url} has ${reviewThreads.totalCount} review threads, over the ${maxNodes} one query reads` }));
	}

	const wanted = reviewRequested(botLogin, mention, comments) ? (thread: ReviewThread) => !thread.isResolved : isPending(mention);

	return Effect.succeed({ url, threadIds: reviewThreads.nodes.filter(wanted).map((thread) => thread.id) });
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
		// The branch's open PR and its pending review threads (see isPending and reviewRequested), or none without an open PR.
		readonly pendingThreads: (repo: string, branch: string) => Effect.Effect<Option.Option<PendingThreads>, CallError>;
		readonly postSummary: (repo: string, number: number, comment: MarkedComment) => Effect.Effect<void, CallError>;
		// A PR comment as the bot, saying a follow-up started.
		readonly postInProgress: (repo: string, number: number, comment: MarkedComment) => Effect.Effect<void, CallError>;
		// One COMMENT review holding every flag as an inline comment on the PR's new code.
		readonly postFlagsReview: (repo: string, number: number, comment: MarkedComment, flags: Flags) => Effect.Effect<void, CallError>;
		readonly replyToThread: (threadId: string, comment: MarkedComment) => Effect.Effect<void, CallError>;
		readonly resolveThread: (threadId: string) => Effect.Effect<void, CallError>;
	}
>()('herdr-linear/GitHub') {
	static readonly layer = Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { bot } = yield* AppConfig;
			const encoder = new TextEncoder();
			const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString);

			// The user's account is gh's default login; the bot's is its own gh config dir.
			const run = (args: ReadonlyArray<string>, input: string, account: Account) => {
				const command = `gh ${args.join(' ')}`;
				const env = account === 'bot' ? { env: { GH_CONFIG_DIR: bot.ghConfigDirectory }, extendEnv: true } : {};

				return Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(ChildProcess.make('gh', args, { stdin: Stream.make(encoder.encode(input)), ...env }));
						const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						if (exitCode !== 0) {
							return yield* Effect.fail(classifyGhFailure(command, exitCode, stderr));
						}

						return stdout;
					}),
				).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new Permanent({ message: `${command}: ${error.message}`, cause: error }))));
			};

			const gh = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>, input = '', account: Account = 'user') =>
				run(args, input, account).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
					Effect.catchTag('SchemaError', (error) => Effect.fail(new Permanent({ message: `gh ${args.join(' ')}: ${error.message}`, cause: error }))),
				);

			// gh exits non-zero when the response carries GraphQL errors.
			const graphql = <A>(schema: Schema.Decoder<A>, query: string, variables: Record<string, unknown>) =>
				gh(Schema.Struct({ data: schema }), ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })).pipe(Effect.map(({ data }) => data));

			const post = (endpoint: string, body: Record<string, unknown>, account: Account = 'user') =>
				gh(Schema.Struct({ id: Schema.Int }), ['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body), account).pipe(Effect.asVoid);

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

				pendingThreads: (repo, branch) =>
					graphql(
						Schema.Struct({ repository: Schema.Struct({ pullRequests: Schema.Struct({ nodes: Schema.Array(PullRequestThreads) }) }) }),
						`query PendingThreads($owner: String!, $name: String!, $branch: String!) {
							repository(owner: $owner, name: $name) {
								pullRequests(headRefName: $branch, states: OPEN, first: 1) {
									nodes {
										url
										comments(last: ${maxNodes}) { totalCount nodes { body author { login } } }
										reviewThreads(first: ${maxNodes}) {
											totalCount
											nodes { id isResolved comments(last: ${maxNodes}) { nodes { body pullRequestReview { body } } } }
										}
									}
								}
							}
						}`,
						{ ...ownerAndName(repo), branch },
					).pipe(
						Effect.flatMap(({ repository }) => {
							const [pullRequest] = repository.pullRequests.nodes;

							return pullRequest ? Effect.map(pendingOf(bot.login, pullRequest), Option.some) : Effect.succeedNone;
						}),
						withPolicy,
					),

				postSummary: (repo, number, { marker, body }) =>
					unlessMarked(
						pullRequestBodies(repo, number, 'comments'),
						marker,
						`${repo}#${number} comments`,
						post(`repos/${repo}/issues/${number}/comments`, { body: asClaude(body) }),
					),

				postInProgress: (repo, number, { marker, body }) =>
					unlessMarked(
						pullRequestBodies(repo, number, 'comments'),
						marker,
						`${repo}#${number} comments`,
						post(`repos/${repo}/issues/${number}/comments`, { body }, 'bot'),
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
			});
		}),
	);
}
