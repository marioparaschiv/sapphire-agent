import { Clock, Effect } from 'effect';
import { AppConfig } from './config.ts';
import { isClaude, mentions } from './github.ts';
import { GitHubApp } from './github-app.ts';
import { Journal, type NewCommand } from './journal.ts';

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// A new comment, review or review comment on an issue or PR. `commentId` is its node id.
export type Comment = Pick<NewCommand, 'commentId' | 'url' | 'author' | 'body' | 'repo' | 'number'>;

// Records a comment that mentions the bot as a command, at most once per comment: queued when its author is in
// bot.allowedUsers and ignored otherwise. Returns whether it queued one.
export const makeRecordMention = Effect.gen(function* () {
	const { bot } = yield* AppConfig;
	const journal = yield* Journal;
	const app = yield* GitHubApp;

	// The App's replies may mention the bot too. The agent shares the user's account, so its own comments carry the
	// onBehalfOf block instead.
	const isRequest = ({ body, author }: Comment) => mentions(bot.login, body) && !isClaude(body) && !sameLogin(author, app.login);

	return (comment: Comment) =>
		Effect.gen(function* () {
			if (!isRequest(comment)) {
				return false;
			}

			const allowed = bot.allowedUsers.some((user) => sameLogin(user, comment.author));

			yield* journal.addCommand({
				...comment,
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
			yield* Effect.log(allowed ? `queued the mention by @${comment.author} in ${comment.url}` : `ignored the mention by @${comment.author} in ${comment.url}: not an allowed user`);

			return allowed;
		});
});
