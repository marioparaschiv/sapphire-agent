import { Context, Effect, Layer, Option } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import {
	asClaude,
	type Bodies,
	containsMarker,
	GitHub,
	maxNodes,
	pendingOf,
	preferredPullRequest,
	type PullRequest,
	type PullRequestState,
	type ReviewThread,
} from './github.ts';
import type { MarkedComment } from './markers.ts';

export type FakeReview = {
	readonly body: string;
	readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number; readonly side: 'RIGHT'; readonly body: string }>;
};

// `reviewBody` is the body of the review the comment was submitted with.
export type FakeThreadComment = { readonly body: string; readonly reviewBody?: string };

type PullRequestRecord = {
	readonly repo: string;
	readonly branch: string;
	pullRequest: PullRequest;
	readonly comments: Array<string>;
	readonly reviews: Array<FakeReview>;
	readonly threadIds: Array<string>;
};

type ThreadRecord = { isResolved: boolean; readonly comments: Array<ReviewThread['comments']['nodes'][number]> };

export type FakeGitHubControls = {
	readonly addPullRequest: (options: { readonly repo: string; readonly branch: string; readonly state?: PullRequestState; readonly author?: string }) => PullRequest;
	readonly setPullRequestState: (repo: string, number: number, state: PullRequestState) => void;
	// Returns the new thread's id.
	readonly addThread: (repo: string, number: number, options: { readonly comments: ReadonlyArray<FakeThreadComment>; readonly isResolved?: boolean }) => string;
	// Issue comment bodies as GitHub stores them, onBehalfOf block included.
	readonly comments: (repo: string, number: number) => ReadonlyArray<string>;
	readonly reviews: (repo: string, number: number) => ReadonlyArray<FakeReview>;
	readonly thread: (threadId: string) => ReviewThread;
	// Counted from this call: the nth write after it is applied, then fails, as if the process died before recording it.
	readonly crashAfterWrite: (nth: number, error: CallError) => void;
	// Writes received so far, failed ones included.
	readonly writes: () => number;
};

// The newest `maxNodes` entries, as the live layer reads them.
const latestBodies = (bodies: ReadonlyArray<string>): Bodies => ({ totalCount: bodies.length, nodes: bodies.slice(-maxNodes).map((body) => ({ body })) });

const makeFake = () => {
	const pullRequests: Array<PullRequestRecord> = [];
	const threads = new Map<string, ThreadRecord>();
	const crashes = new Map<number, CallError>();
	let writes = 0;

	const findRecord = (repo: string, number: number) => pullRequests.find((record) => record.repo === repo && record.pullRequest.number === number);

	const record = (repo: string, number: number) =>
		Effect.suspend(() => {
			const found = findRecord(repo, number);

			return found ? Effect.succeed(found) : Effect.fail(new Permanent({ message: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)` }));
		});

	const threadRecord = (threadId: string) =>
		Effect.suspend(() => {
			const found = threads.get(threadId);

			return found ? Effect.succeed(found) : Effect.fail(new Permanent({ message: `no review thread ${threadId}` }));
		});

	const threadView = (id: string, { isResolved, comments }: ThreadRecord): ReviewThread => ({ id, isResolved, comments: { nodes: [...comments] } });

	const write = (apply: () => void) =>
		Effect.suspend(() => {
			writes += 1;
			apply();

			const crash = crashes.get(writes);

			return crash ? Effect.fail(crash) : Effect.void;
		});

	const unlessMarked = (bodies: ReadonlyArray<string>, comment: MarkedComment, where: string, apply: () => void) =>
		containsMarker(latestBodies(bodies), comment.marker, where).pipe(Effect.flatMap((marked) => (marked ? Effect.void : write(apply))));

	const github = GitHub.of({
		findPullRequest: (repo, branch) =>
			Effect.sync(() =>
				preferredPullRequest(
					pullRequests
						.filter((record) => record.repo === repo && record.branch === branch)
						.map(({ pullRequest }) => pullRequest)
						.reverse(),
				),
			),

		pendingThreads: (repo, branch) =>
			Effect.suspend(() => {
				const open = pullRequests.find((record) => record.repo === repo && record.branch === branch && record.pullRequest.state === 'OPEN');

				if (!open) {
					return Effect.succeedNone;
				}

				const nodes = open.threadIds.slice(0, maxNodes).flatMap((id) => {
					const thread = threads.get(id);

					return thread ? [threadView(id, thread)] : [];
				});

				return Effect.map(pendingOf({ url: open.pullRequest.url, reviewThreads: { totalCount: open.threadIds.length, nodes } }), Option.some);
			}),

		postSummary: (repo, number, comment) =>
			record(repo, number).pipe(
				Effect.flatMap((found) => unlessMarked(found.comments, comment, `${repo}#${number} comments`, () => found.comments.push(asClaude(comment.body)))),
			),

		postFlagsReview: (repo, number, comment, flags) =>
			record(repo, number).pipe(
				Effect.flatMap((found) =>
					unlessMarked(
						found.reviews.map(({ body }) => body),
						comment,
						`${repo}#${number} reviews`,
						() =>
							found.reviews.push({
								body: asClaude(comment.body),
								comments: flags.map(({ path, line, body }) => ({ path, line, side: 'RIGHT', body: asClaude(body) })),
							}),
					),
				),
			),

		replyToThread: (threadId, comment) =>
			threadRecord(threadId).pipe(
				Effect.flatMap((thread) =>
					unlessMarked(
						thread.comments.map(({ body }) => body),
						comment,
						`review thread ${threadId}`,
						() => thread.comments.push({ body: asClaude(comment.body), pullRequestReview: null }),
					),
				),
			),

		resolveThread: (threadId) =>
			threadRecord(threadId).pipe(
				Effect.flatMap((thread) =>
					thread.isResolved
						? Effect.void
						: write(() => {
								thread.isResolved = true;
							}),
				),
			),
	});

	const controls: FakeGitHubControls = {
		addPullRequest: ({ repo, branch, state = 'OPEN', author = 'octocat' }) => {
			const number = pullRequests.filter((record) => record.repo === repo).length + 1;
			const pullRequest = { number, url: `https://github.com/${repo}/pull/${number}`, state, author: { login: author } };

			pullRequests.push({ repo, branch, pullRequest, comments: [], reviews: [], threadIds: [] });

			return pullRequest;
		},

		setPullRequestState: (repo, number, state) => {
			const found = findRecord(repo, number);

			if (!found) {
				throw new Error(`no pull request ${repo}#${number}`);
			}

			found.pullRequest = { ...found.pullRequest, state };
		},

		addThread: (repo, number, { comments, isResolved = false }) => {
			const found = findRecord(repo, number);

			if (!found) {
				throw new Error(`no pull request ${repo}#${number}`);
			}

			const id = `PRRT_${threads.size + 1}`;

			threads.set(id, { isResolved, comments: comments.map(({ body, reviewBody }) => ({ body, pullRequestReview: reviewBody === undefined ? null : { body: reviewBody } })) });
			found.threadIds.push(id);

			return id;
		},

		comments: (repo, number) => [...(findRecord(repo, number)?.comments ?? [])],

		reviews: (repo, number) => [...(findRecord(repo, number)?.reviews ?? [])],

		thread: (threadId) => {
			const found = threads.get(threadId);

			if (!found) {
				throw new Error(`no review thread ${threadId}`);
			}

			return threadView(threadId, found);
		},

		crashAfterWrite: (nth, error) => {
			crashes.set(writes + nth, error);
		},
		writes: () => writes,
	};

	return { github, controls };
};

// In-memory GitHub with the live layer's marker, cap and pending-thread rules. Its layer provides both GitHub and
// these controls, with fresh state each time it is built.
export class FakeGitHub extends Context.Service<FakeGitHub, FakeGitHubControls>()('herdr-linear/FakeGitHub') {
	static readonly layer = Layer.effectContext(
		Effect.sync(() => {
			const { github, controls } = makeFake();

			return Context.make(GitHub, github).pipe(Context.add(FakeGitHub, controls));
		}),
	);
}
