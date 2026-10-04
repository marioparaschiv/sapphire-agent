import { Context, Effect, Layer, Option } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { GitHubApp } from './github-app.ts';
import { asClaude, type Bodies, containsMarker, GitHub, type GitHubComment, maxNodes, mentions, type Notification, notificationsPerTick, preferredPullRequest, type PullRequest, type PullRequestState } from './github.ts';
import type { MarkedComment } from './markers.ts';

export type FakeReview = {
	readonly body: string;
	readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number; readonly side: 'RIGHT'; readonly body: string }>;
};

// A comment, review or review comment as GitHub stores it. `createdAt` is epoch milliseconds.
export type FakeComment = { readonly id: string; readonly url: string; readonly body: string; readonly author: string; readonly createdAt: number };

export type FakeThread = { readonly id: string; readonly isResolved: boolean; readonly comments: ReadonlyArray<FakeComment> };

type PullRequestRecord = {
	readonly repo: string;
	readonly branch: string;
	pullRequest: PullRequest;
	readonly comments: Array<FakeComment>;
	// Reviews with a body written by a person; the flags reviews go to `flagReviews`.
	readonly reviews: Array<FakeComment>;
	readonly flagReviews: Array<FakeReview>;
	readonly threadIds: Array<string>;
};

type ThreadRecord = { isResolved: boolean; readonly comments: Array<FakeComment> };

type NotificationRecord = { readonly threadId: string; unread: boolean; lastReadAt: number | null };

export type FakeGitHubControls = {
	readonly addPullRequest: (options: { readonly repo: string; readonly branch: string; readonly state?: PullRequestState; readonly author?: string }) => PullRequest;
	readonly setPullRequestState: (repo: string, number: number, state: PullRequestState) => void;
	// A comment on the PR itself, by the PR's author unless `author` is given. Returns it.
	readonly addComment: (repo: string, number: number, body: string, author?: string) => FakeComment;
	// A review with a body, by the PR's author unless `author` is given. Returns it.
	readonly addReview: (repo: string, number: number, body: string, author?: string) => FakeComment;
	// Returns the new thread's id. Comments are by the PR's author unless they name one.
	readonly addThread: (
		repo: string,
		number: number,
		options: { readonly comments: ReadonlyArray<{ readonly body: string; readonly author?: string }>; readonly isResolved?: boolean },
	) => string;
	// Issue comment bodies as GitHub stores them, onBehalfOf block included.
	readonly comments: (repo: string, number: number) => ReadonlyArray<string>;
	// The comments the GitHub App posted on the PR.
	readonly botComments: (repo: string, number: number) => ReadonlyArray<string>;
	readonly reviews: (repo: string, number: number) => ReadonlyArray<FakeReview>;
	readonly thread: (threadId: string) => FakeThread;
	// Whether the bot has an unread notification about the PR.
	readonly unread: (repo: string, number: number) => boolean;
	// What GitHub stamps on everything written from now on, in epoch milliseconds.
	readonly setTime: (millis: number) => void;
	// Counted from this call: the nth write after it is applied, then fails, as if the process died before recording it.
	readonly crashAfterWrite: (nth: number, error: CallError) => void;
	// Writes received so far, failed ones included.
	readonly writes: () => number;
};

// The newest `maxNodes` entries, as the live layer reads them.
const latestBodies = (bodies: ReadonlyArray<string>): Bodies => ({ totalCount: bodies.length, nodes: bodies.slice(-maxNodes).map((body) => ({ body })) });

const toGitHubComment = ({ id, url, body, author, createdAt }: FakeComment): GitHubComment => ({ id, url, body, createdAt: new Date(createdAt).toISOString(), author: { login: author } });

// The user and the agent share the PR author's account; the bot user and the GitHub App have their own. A comment that
// mentions the bot user, by anyone but itself, gives it an unread notification about the PR, as GitHub does.
const makeFake = (botLogin: string, appLogin: string) => {
	const pullRequests: Array<PullRequestRecord> = [];
	const threads = new Map<string, ThreadRecord>();
	const notifications = new Map<string, NotificationRecord>();
	const crashes = new Map<number, CallError>();
	let writes = 0;
	let ids = 0;
	let now = Date.UTC(2026, 9, 4);

	const stamp = () => {
		ids += 1;
		now += 1000;

		return { serial: ids, createdAt: now };
	};

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

	const threadRecord = (threadId: string) =>
		Effect.suspend(() => {
			const found = threads.get(threadId);

			return found ? Effect.succeed(found) : Effect.fail(new Permanent({ message: `no review thread ${threadId}` }));
		});

	const notify = (repo: string, number: number, comment: FakeComment) => {
		if (comment.author === botLogin || !mentions(botLogin, comment.body)) {
			return;
		}

		const key = `${repo}#${number}`;
		const existing = notifications.get(key);

		if (existing) {
			existing.unread = true;

			return;
		}

		notifications.set(key, { threadId: `${notifications.size + 1}`, unread: true, lastReadAt: null });
	};

	const comment = (repo: string, number: number, anchor: string, body: string, author: string): FakeComment => {
		const { serial, createdAt } = stamp();
		const created = { id: `${anchor}_${serial}`, url: `https://github.com/${repo}/pull/${number}#${anchor}-${serial}`, body, author, createdAt };

		notify(repo, number, created);

		return created;
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

		postSummary: (repo, number, marked) =>
			record(repo, number).pipe(
				Effect.flatMap((found) =>
					unlessMarked(
						found.comments.map(({ body }) => body),
						marked,
						`${repo}#${number} comments`,
						() => found.comments.push(comment(repo, number, 'issuecomment', asClaude(marked.body), found.pullRequest.author.login)),
					),
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
								body: asClaude(marked.body),
								comments: flags.map(({ path, line, body }) => ({ path, line, side: 'RIGHT', body: asClaude(body) })),
							}),
					),
				),
			),

		replyToThread: (threadId, marked) =>
			threadRecord(threadId).pipe(
				Effect.flatMap((thread) =>
					unlessMarked(
						thread.comments.map(({ body }) => body),
						marked,
						`review thread ${threadId}`,
						() => {
							const pullRequest = pullRequests.find((candidate) => candidate.threadIds.includes(threadId));

							if (pullRequest) {
								thread.comments.push(comment(pullRequest.repo, pullRequest.pullRequest.number, 'discussion_r', asClaude(marked.body), pullRequest.pullRequest.author.login));
							}
						},
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

		notifications: Effect.sync(() =>
			[...notifications.entries()]
				.filter(([, notification]) => notification.unread)
				.slice(0, notificationsPerTick)
				.map(([key, { threadId, lastReadAt }]): Notification => {
					const [repo, number] = key.split('#');

					return { threadId, repo, number: Number(number), lastReadAt: Option.fromNullishOr(lastReadAt) };
				}),
		),

		markNotificationRead: (threadId) =>
			write(() => {
				const found = [...notifications.values()].find((notification) => notification.threadId === threadId);

				if (found?.unread) {
					found.unread = false;
					found.lastReadAt = stamp().createdAt;
				}
			}),

		conversation: (repo, number) =>
			record(repo, number).pipe(
				Effect.map((found) =>
					[
						...found.comments.slice(-maxNodes),
						...found.reviews.slice(-maxNodes),
						...found.threadIds.flatMap((id) => threads.get(id)?.comments ?? []),
					].map(toGitHubComment),
				),
			),

		postAsBot: (repo, number, marked) =>
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
	});

	const controls: FakeGitHubControls = {
		addPullRequest: ({ repo, branch, state = 'OPEN', author = 'octocat' }) => {
			const number = pullRequests.filter((candidate) => candidate.repo === repo).length + 1;
			const pullRequest = { number, url: `https://github.com/${repo}/pull/${number}`, state, author: { login: author } };

			pullRequests.push({ repo, branch, pullRequest, comments: [], reviews: [], flagReviews: [], threadIds: [] });

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

		addReview: (repo, number, body, author) => {
			const found = existingRecord(repo, number);
			const created = comment(repo, number, 'pullrequestreview', body, author ?? found.pullRequest.author.login);

			found.reviews.push(created);

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

		unread: (repo, number) => notifications.get(`${repo}#${number}`)?.unread ?? false,

		setTime: (millis) => {
			now = millis;
		},

		crashAfterWrite: (nth, error) => {
			crashes.set(writes + nth, error);
		},
		writes: () => writes,
	};

	return { github, controls };
};

// In-memory GitHub with the live layer's marker and cap rules and GitHub's mention notifications. Its layer provides
// both GitHub and these controls, with fresh state each time it is built.
export class FakeGitHub extends Context.Service<FakeGitHub, FakeGitHubControls>()('herdr-linear/FakeGitHub') {
	static readonly layer = Layer.effectContext(
		Effect.gen(function* () {
			const { bot } = yield* AppConfig;
			const app = yield* GitHubApp;
			const { github, controls } = makeFake(bot.login, app.login);

			return Context.make(GitHub, github).pipe(Context.add(FakeGitHub, controls));
		}),
	);
}
