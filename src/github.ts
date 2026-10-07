import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy } from './call-policy.ts';
import { GitHubApp } from './github-app.ts';
import { hasMarker, type MarkedComment, type Marker } from './markers.ts';

export const PullRequestState = Schema.Literals(['OPEN', 'CLOSED', 'MERGED']);

export type PullRequestState = typeof PullRequestState.Type;

export const PullRequest = Schema.Struct({
	number: Schema.Int,
	url: Schema.String,
	state: PullRequestState,
	author: Schema.Struct({ login: Schema.String }),
	// The commit the PR's branch pointed at last, kept by GitHub after a squash merge deleted the branch.
	headRefOid: Schema.String,
});

export type PullRequest = typeof PullRequest.Type;

// A page of a GitHub connection, enough to look for a marker.
export const Bodies = Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(Schema.Struct({ body: Schema.String })) });

export type Bodies = typeof Bodies.Type;

// `@<login>` as a whole word, so neither `@<login>x` nor an email address like `a@<login>` counts. GitHub logins are
// case-insensitive.
export const mentions = (login: string, body: string) => new RegExp(`(?<![\\w@-])@${RegExp.escape(login)}(?![\\w-])`, 'i').test(body);

// GitHub caps a connection page at 100 nodes.
export const maxNodes = 100;

// The open PR for the branch if there is one, else a merged one, else a closed one.
export const preferredPullRequest = (pullRequests: ReadonlyArray<PullRequest>) =>
	Option.fromUndefinedOr(pullRequests.find((pr) => pr.state === 'OPEN') ?? pullRequests.find((pr) => pr.state === 'MERGED') ?? pullRequests[0]);

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
		readonly replyToThread: (repo: string, threadId: string, comment: MarkedComment) => Effect.Effect<void, CallError>;
		readonly resolveThread: (repo: string, threadId: string) => Effect.Effect<void, CallError>;
		// A conversation comment on the issue or PR.
		readonly postComment: (repo: string, number: number, comment: MarkedComment) => Effect.Effect<void, CallError>;
		// A thumbs-up on a comment or review, by its node id. Adding one it already has changes nothing.
		readonly addThumbsUp: (repo: string, subjectId: string) => Effect.Effect<void, CallError>;
	}
>()('sapphire-agent/GitHub') {
	static readonly layer = Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const app = yield* GitHubApp;
			const encoder = new TextEncoder();
			const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString);

			// The user's account is gh's default login, for reads. Every write passes `token`, the installation token of the
			// GitHub App on the repo it lands on.
			const run = (args: ReadonlyArray<string>, input: string, token?: Redacted.Redacted<string>) => {
				const command = `gh ${args.join(' ')}`;
				const options = token ? { env: { GH_TOKEN: Redacted.value(token) }, extendEnv: true } : {};

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

			const gh = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>, input = '', token?: Redacted.Redacted<string>) =>
				run(args, input, token).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
					Effect.catchTag('SchemaError', (error) => Effect.fail(new Permanent({ message: `gh ${args.join(' ')}: ${error.message}`, cause: error }))),
				);

			// gh exits non-zero when the response carries GraphQL errors.
			const graphql = <A>(schema: Schema.Decoder<A>, query: string, variables: Record<string, unknown>, token?: Redacted.Redacted<string>) =>
				gh(Schema.Struct({ data: schema }), ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }), token).pipe(Effect.map(({ data }) => data));

			const post = (endpoint: string, body: Record<string, unknown>, token?: Redacted.Redacted<string>) =>
				gh(Schema.Struct({ id: Schema.Int }), ['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body), token).pipe(Effect.asVoid);

			const ownerAndName = (repo: string) => {
				const [owner, name] = repo.split('/');

				return { owner, name };
			};

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
					gh(Schema.Array(PullRequest), ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,author,headRefOid']).pipe(
						Effect.map(preferredPullRequest),
						withPolicy,
					),

				replyToThread: (repo, threadId, { marker, body }) =>
					Effect.flatMap(app.installationToken(repo), (token) =>
						unlessMarked(
							Effect.map(reviewThread(threadId), ({ comments }) => comments),
							marker,
							`review thread ${threadId}`,
							graphql(
								Schema.Struct({ addPullRequestReviewThreadReply: Schema.Struct({ comment: Schema.Struct({ id: Schema.String }) }) }),
								`mutation ReplyToThread($threadId: ID!, $body: String!) {
									addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
								}`,
								{ threadId, body },
								token,
							).pipe(Effect.asVoid),
						),
					),

				resolveThread: (repo, threadId) =>
					Effect.flatMap(app.installationToken(repo), (token) =>
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
											token,
										).pipe(Effect.asVoid),
							),
							withPolicy,
						),
					),

				postComment: (repo, number, { marker, body }) =>
					Effect.flatMap(app.installationToken(repo), (token) =>
						unlessMarked(conversationBodies(repo, number), marker, `${repo}#${number} comments`, post(`repos/${repo}/issues/${number}/comments`, { body }, token)),
					),

				addThumbsUp: (repo, subjectId) =>
					Effect.flatMap(app.installationToken(repo), (token) =>
						graphql(
							Schema.Struct({ addReaction: Schema.Struct({ reaction: Schema.Struct({ content: Schema.Literal('THUMBS_UP') }) }) }),
							`mutation AddThumbsUp($subjectId: ID!) {
								addReaction(input: { subjectId: $subjectId, content: THUMBS_UP }) { reaction { content } }
							}`,
							{ subjectId },
							token,
						).pipe(Effect.asVoid, withPolicy),
					),
			});
		}),
	);
}
