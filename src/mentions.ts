import { Clock, Effect, Option } from 'effect';
import { AppConfig } from './config.ts';
import { GitHub, type GitHubComment, isClaude, mentions, notificationsPerTick } from './github.ts';
import { GitHubApp } from './github-app.ts';
import { Journal, type MentionThread } from './journal.ts';
import type { Rule } from './planner.ts';

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Turns the bot's GitHub notifications into commands, at most once per comment. Each unread notification's thread is
// recorded in the journal before the notification is marked read, and scanned after: every comment on it since the
// bot last read it that mentions the bot is recorded as a command, queued when its author is in bot.allowedUsers and
// ignored otherwise. A comment written while this runs either lands before the scan or makes the notification unread
// again, and a crash at any point leaves the thread in the journal for the next tick, whose scan finds the comments
// recorded already and skips them. Not paused: `resume` itself comes in as a command.
export const mentionsRule = Effect.gen(function* () {
	const { bot } = yield* AppConfig;
	const journal = yield* Journal;
	const github = yield* GitHub;
	const app = yield* GitHubApp;

	// The App's replies may mention the bot too. The agent shares the user's account, so its own comments carry the
	// onBehalfOf block instead.
	const isRequest = (since: number) => (comment: GitHubComment) =>
		Date.parse(comment.createdAt) >= since &&
		mentions(bot.login, comment.body) &&
		!isClaude(comment.body) &&
		!Option.exists(Option.fromNullishOr(comment.author), ({ login }) => sameLogin(login, app.login));

	const scan = ({ threadId, repo, number, since }: MentionThread) =>
		Effect.gen(function* () {
			const found = (yield* github.conversation(repo, number)).filter(isRequest(since)).toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

			for (const { id, url, body, author } of found) {
				const login = author?.login ?? 'ghost';
				const allowed = bot.allowedUsers.some((user) => sameLogin(user, login));

				yield* journal.addCommand({
					commentId: id,
					url,
					author: login,
					body,
					repo,
					number,
					status: allowed ? 'queued' : 'ignored',
					cwd: null,
					tabId: null,
					paneId: null,
					recordedAt: yield* Clock.currentTimeMillis,
					claimedAt: null,
					startedAt: null,
					agentStatus: null,
					agentStatusSince: null,
					nudgedAt: null,
					tailHash: null,
				});
				yield* Effect.log(allowed ? `queued the mention by @${login} in ${url}` : `ignored the mention by @${login} in ${url}: not an allowed user`);
			}

			yield* journal.deleteMentionThread(threadId);
		}).pipe(
			// e.g. the issue was deleted: scanning again cannot help.
			Effect.catchTag('Permanent', (error) =>
				Effect.logError(`cannot read ${repo}#${number}; dropped its notification`, error).pipe(Effect.andThen(journal.deleteMentionThread(threadId))),
			),
		);

	const apply = Effect.gen(function* () {
		const floor = yield* journal.mentionFloor;

		for (const { threadId, repo, number, lastReadAt } of yield* github.notifications) {
			yield* journal.addMentionThread({ threadId, repo, number, since: Math.max(floor, Option.getOrElse(lastReadAt, () => floor)) });
			yield* github.markNotificationRead(threadId);
		}

		yield* Effect.forEach(yield* journal.listMentionThreads(notificationsPerTick), scan, { discard: true });
	});

	return { name: 'mentions', pausable: false, plan: () => Effect.succeed([{ task: 'mentions', apply }]) } satisfies Rule;
});
