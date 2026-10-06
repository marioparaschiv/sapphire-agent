import { Context, Effect, Layer } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import { GitHubApp } from './github-app.ts';
import { type Bodies, containsMarker, GitHub, maxNodes, preferredPullRequest, type PullRequest, type PullRequestState } from './github.ts';
import type { MarkedComment } from './markers.ts';

export type FakeReview = {
	readonly body: string;
	readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number; readonly side: 'RIGHT'; readonly body: string }>;
};

// A comment or review comment as GitHub stores it. `id` is its node id.
export type FakeComment = { readonly id: string; readonly url: string; readonly body: string; readonly author: string };

export type FakeThread = { readonly id: string; readonly isResolved: boolean; readonly comments: ReadonlyArray<FakeComment> };

type PullRequestRecord = {
	readonly repo: string;
	readonly branch: string;
	pullRequest: PullRequest;
	readonly comments: Array<FakeComment>;
	readonly flagReviews: Array<FakeReview>;
	readonly threadIds: Array<string>;
};

type ThreadRecord = { isResolved: boolean; readonly comments: Array<FakeComment> };

export type FakeGitHubControls = {
	readonly addPullRequest: (options: { readonly repo: string; readonly branch: string; readonly state?: PullRequestState; readonly author?: string }) => PullRequest;
	readonly setPullRequestState: (repo: string, number: number, state: PullRequestState) => void;
	// A comment on the PR itself, by the PR's author unless `author` is given. Returns it.
	readonly addComment: (repo: string, number: number, body: string, author?: string) => FakeComment;
	// Returns the new thread's id. Comments are by the PR's author unless they name one.
	readonly addThread: (
		repo: string,
		number: number,
		options: { readonly comments: ReadonlyArray<{ readonly body: string; readonly author?: string }>; readonly isResolved?: boolean },
	) => string;
	// Conversation comment bodies on the PR, by anyone.
	readonly comments: (repo: string, number: number) => ReadonlyArray<string>;
	// The comments the GitHub App posted on the PR.
	readonly botComments: (repo: string, number: number) => ReadonlyArray<string>;
	readonly reviews: (repo: string, number: number) => ReadonlyArray<FakeReview>;
	readonly thread: (threadId: string) => FakeThread;
	// Whether the GitHub App gave the comment with this node id a thumbs-up.
	readonly hasThumbsUp: (commentId: string) => boolean;
	// Counted from this call: the nth write after it is applied, then fails, as if the process died before recording it.
	readonly crashAfterWrite: (nth: number, error: CallError) => void;
	// Writes received so far, failed ones included.
	readonly writes: () => number;
};

// The newest `maxNodes` entries, as the live layer reads them.
const latestBodies = (bodies: ReadonlyArray<string>): Bodies => ({ totalCount: bodies.length, nodes: bodies.slice(-maxNodes).map((body) => ({ body })) });

// How GitHub names a conversation comment and a review comment: the node id's prefix and the URL's anchor.
const commentKinds = {
	issuecomment: { nodePrefix: 'IC', anchor: 'issuecomment-' },
	discussion_r: { nodePrefix: 'PRRC', anchor: 'discussion_r' },
};

// The user is the PR's author; the GitHub App writes as its own login.
const makeFake = (appLogin: string) => {
	const pullRequests: Array<PullRequestRecord> = [];
	const threads = new Map<string, ThreadRecord>();
	const crashes = new Map<number, CallError>();
	const thumbsUps = new Set<string>();
	let writes = 0;
	let ids = 0;

	const findRecord = (repo: string, number: number) => pullRequests.find((record) => record.repo === repo && record.pullRequest.number === number);

	// For controls, where a missing PR is a mistake in the test.
	const existingRecord = (repo: string, number: number) => {
		const found = findRecord(repo, number);

		if (!found) {
			throw new Error(`no pull request ${repo}#${number}`);
		}

		return found;
	};

	const record = (repo: string, number: number) =>
		Effect.suspend(() => {
			const found = findRecord(repo, number);

			return found ? Effect.succeed(found) : Effect.fail(new Permanent({ message: `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issueOrPullRequest)` }));
		});

	const threadRecord = (repo: string, threadId: string) =>
		Effect.suspend(() => {
			const pullRequest = pullRequests.find((candidate) => candidate.repo === repo && candidate.threadIds.includes(threadId));
			const thread = threads.get(threadId);

			return pullRequest && thread ? Effect.succeed({ pullRequest, thread }) : Effect.fail(new Permanent({ message: `no review thread ${threadId} on ${repo}` }));
		});

	const comment = (repo: string, number: number, kind: keyof typeof commentKinds, body: string, author: string): FakeComment => {
		const { nodePrefix, anchor } = commentKinds[kind];

		ids += 1;

		return { id: `${nodePrefix}_kwDO${ids}`, url: `https://github.com/${repo}/pull/${number}#${anchor}${ids}`, body, author };
	};

	const write = (apply: () => void) =>
		Effect.suspend(() => {
			writes += 1;
			apply();

			const crash = crashes.get(writes);

			return crash ? Effect.fail(crash) : Effect.void;
		});

	const unlessMarked = (bodies: ReadonlyArray<string>, marked: MarkedComment, where: string, apply: () => void) =>
		containsMarker(latestBodies(bodies), marked.marker, where).pipe(Effect.flatMap((found) => (found ? Effect.void : write(apply))));

	const github = GitHub.of({
		findPullRequest: (repo, branch) =>
			Effect.sync(() =>
				preferredPullRequest(
					pullRequests
						.filter((candidate) => candidate.repo === repo && candidate.branch === branch)
						.map(({ pullRequest }) => pullRequest)
						.reverse(),
				),
			),

		postFlagsReview: (repo, number, marked, flags) =>
			record(repo, number).pipe(
				Effect.flatMap((found) =>
					unlessMarked(
						found.flagReviews.map(({ body }) => body),
						marked,
						`${repo}#${number} reviews`,
						() =>
							found.flagReviews.push({
								body: marked.body,
								comments: flags.map(({ path, line, body }) => ({ path, line, side: 'RIGHT', body })),
							}),
					),
				),
			),

		replyToThread: (repo, threadId, marked) =>
			threadRecord(repo, threadId).pipe(
				Effect.flatMap(({ pullRequest, thread }) =>
					unlessMarked(
						thread.comments.map(({ body }) => body),
						marked,
						`review thread ${threadId}`,
						() => thread.comments.push(comment(repo, pullRequest.pullRequest.number, 'discussion_r', marked.body, appLogin)),
					),
				),
			),

		resolveThread: (repo, threadId) =>
			threadRecord(repo, threadId).pipe(
				Effect.flatMap(({ thread }) =>
					thread.isResolved
						? Effect.void
						: write(() => {
								thread.isResolved = true;
							}),
				),
			),

		postComment: (repo, number, marked) =>
			record(repo, number).pipe(
				Effect.flatMap((found) =>
					unlessMarked(
						found.comments.map(({ body }) => body),
						marked,
						`${repo}#${number} comments`,
						() => found.comments.push(comment(repo, number, 'issuecomment', marked.body, appLogin)),
					),
				),
			),

		addThumbsUp: (repo, subjectId) =>
			Effect.suspend(() => {
				const comments = pullRequests
					.filter((candidate) => candidate.repo === repo)
					.flatMap((candidate) => [...candidate.comments, ...candidate.threadIds.flatMap((id) => threads.get(id)?.comments ?? [])]);

				if (!comments.some(({ id }) => id === subjectId)) {
					return Effect.fail(new Permanent({ message: `GraphQL: Could not resolve to a node with the global id of '${subjectId}'. (addReaction)` }));
				}

				return thumbsUps.has(subjectId) ? Effect.void : write(() => thumbsUps.add(subjectId));
			}),
	});

	const controls: FakeGitHubControls = {
		addPullRequest: ({ repo, branch, state = 'OPEN', author = 'octocat' }) => {
			const number = pullRequests.filter((candidate) => candidate.repo === repo).length + 1;
			const pullRequest = { number, url: `https://github.com/${repo}/pull/${number}`, state, author: { login: author } };

			pullRequests.push({ repo, branch, pullRequest, comments: [], flagReviews: [], threadIds: [] });

			return pullRequest;
		},

		setPullRequestState: (repo, number, state) => {
			const found = existingRecord(repo, number);

			found.pullRequest = { ...found.pullRequest, state };
		},

		addComment: (repo, number, body, author) => {
			const found = existingRecord(repo, number);
			const created = comment(repo, number, 'issuecomment', body, author ?? found.pullRequest.author.login);

			found.comments.push(created);

			return created;
		},

		addThread: (repo, number, { comments, isResolved = false }) => {
			const found = existingRecord(repo, number);
			const id = `PRRT_${threads.size + 1}`;

			threads.set(id, { isResolved, comments: comments.map(({ body, author }) => comment(repo, number, 'discussion_r', body, author ?? found.pullRequest.author.login)) });
			found.threadIds.push(id);

			return id;
		},

		comments: (repo, number) => (findRecord(repo, number)?.comments ?? []).map(({ body }) => body),

		botComments: (repo, number) => (findRecord(repo, number)?.comments ?? []).filter(({ author }) => author === appLogin).map(({ body }) => body),

		reviews: (repo, number) => [...(findRecord(repo, number)?.flagReviews ?? [])],

		thread: (threadId) => {
			const found = threads.get(threadId);

			if (!found) {
				throw new Error(`no review thread ${threadId}`);
			}

			return { id: threadId, isResolved: found.isResolved, comments: [...found.comments] };
		},

		hasThumbsUp: (commentId) => thumbsUps.has(commentId),

		crashAfterWrite: (nth, error) => {
			crashes.set(writes + nth, error);
		},
		writes: () => writes,
	};

	return { github, controls };
};

// In-memory GitHub with the live layer's marker and cap rules. Its layer provides both GitHub and these controls, with
// fresh state each time it is built.
export class FakeGitHub extends Context.Service<FakeGitHub, FakeGitHubControls>()('sapphire-agent/FakeGitHub') {
	static readonly layer = Layer.effectContext(
		Effect.gen(function* () {
			const app = yield* GitHubApp;
			const { github, controls } = makeFake(app.login);

			return Context.make(GitHub, github).pipe(Context.add(FakeGitHub, controls));
		}),
	);
}
