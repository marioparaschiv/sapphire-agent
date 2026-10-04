import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { asClaude } from './github.ts';
import type { Command } from './journal.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const processDied = new Transient({ message: 'the process died' });

const reviewedPullRequest = (h: Harness) => h.github.addPullRequest({ repo: h.githubRepo, branch: 'mario/test-10-plugin-settings-sync', author: 'marioparaschiv' });

const described = (commands: ReadonlyArray<Command>) => commands.map(({ author, body, status }) => [author, body, status]);

describe('mentions', () => {
	it.effect("queues a mention by an allowed user, ignores one by anyone else, and never counts the bot's or the agent's own comments", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);

			h.github.addComment(h.githubRepo, number, '@OrchestratorBot stop TEST-12', 'MarioParaschiv');
			h.github.addComment(h.githubRepo, number, '@orchestratorbot merge this', 'stranger');
			h.github.addComment(h.githubRepo, number, asClaude('Ready for review. Mention @orchestratorbot to ask for changes.'));
			h.github.addComment(h.githubRepo, number, 'Mention @orchestratorbot again to retry.', 'orchestratorbot');
			h.github.addComment(h.githubRepo, number, 'Thanks, orchestratorbot.');
			yield* h.tick;

			assert.deepStrictEqual(described(yield* h.commands), [
				['MarioParaschiv', '@OrchestratorBot stop TEST-12', 'running'],
				['stranger', '@orchestratorbot merge this', 'ignored'],
			]);
			assert.deepStrictEqual(
				h.herdr.starts().map(({ name }) => name),
				['cmd-1'],
			);
			assert.isFalse(h.github.unread(h.githubRepo, number));

			yield* h.tick;
			assert.lengthOf(yield* h.commands, 2);
		}),
	);

	it.effect('records every mention in a thread since the bot last read it, oldest first: a comment, a review and a review comment', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);

			h.github.addComment(h.githubRepo, number, '@orchestratorbot pause everything');
			h.github.addReview(h.githubRepo, number, 'A few things. @orchestratorbot have a follow-up fix them');
			h.github.addThread(h.githubRepo, number, { comments: [{ body: '@orchestratorbot tell the agent to use the existing helper' }] });
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.commands).map(({ id, body, status }) => [id, body, status]),
				[
					[1, '@orchestratorbot pause everything', 'running'],
					[2, 'A few things. @orchestratorbot have a follow-up fix them', 'queued'],
					[3, '@orchestratorbot tell the agent to use the existing helper', 'queued'],
				],
			);
			assert.match((yield* h.commands)[1].url, /#pullrequestreview-\d+$/);
			assert.match((yield* h.commands)[2].url, /#discussion_r-\d+$/);

			h.github.addComment(h.githubRepo, number, '@orchestratorbot start TEST-14');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.commands).map(({ id, body }) => [id, body]),
				[
					[1, '@orchestratorbot pause everything'],
					[2, 'A few things. @orchestratorbot have a follow-up fix them'],
					[3, '@orchestratorbot tell the agent to use the existing helper'],
					[4, '@orchestratorbot start TEST-14'],
				],
			);
		}),
	);

	it.effect('never runs a mention written before the journal existed', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.UTC(2027, 0, 1));

			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);

			h.github.addThread(h.githubRepo, number, { comments: [{ body: 'Rename this. @orchestratorbot' }] });
			yield* h.tick;

			assert.deepStrictEqual(yield* h.commands, []);
			assert.isFalse(h.github.unread(h.githubRepo, number));

			h.github.setTime(Date.UTC(2027, 0, 2));
			h.github.addComment(h.githubRepo, number, '@orchestratorbot status please');
			yield* h.tick;

			assert.deepStrictEqual(described(yield* h.commands), [['marioparaschiv', '@orchestratorbot status please', 'running']]);
		}),
	);

	it.effect('turns a mention into exactly one command run when the process dies at any write on the way, after a restart', () =>
		Effect.gen(function* () {
			// Journal: the thread, the command, dropping the thread, then the claim, its directory, its tab and running.
			// GitHub: marking the notification read. herdr: creating the workspace, naming its tab and starting Claude.
			const points = [
				...[1, 2, 3, 4, 5, 6, 7].map((nth) => ({ kind: 'journal', nth }) as const),
				{ kind: 'github', nth: 1 } as const,
				...[1, 2, 3].map((nth) => ({ kind: 'herdr', nth }) as const),
			];

			for (const { kind, nth } of points) {
				const where = `crash at ${kind} write ${nth}`;
				const h = yield* makeHarness();
				const { number } = reviewedPullRequest(h);

				h.github.addComment(h.githubRepo, number, '@orchestratorbot what is running?');

				if (kind === 'journal') {
					h.crashAtJournalWrite(nth);
				} else {
					h[kind].crashAfterWrite(nth, processDied);
				}

				yield* h.tick;
				assert.isTrue(kind === 'journal' ? h.crashed() : h[kind].writes() >= nth, `${where} never happened`);

				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				assert.deepStrictEqual(described(yield* h.commands), [['marioparaschiv', '@orchestratorbot what is running?', 'running']], where);
				assert.lengthOf(h.herdr.starts(), 1, where);
				assert.lengthOf(
					h.herdr.tabs().filter((tab) => tab.label === '@bot CMD-1'),
					1,
					where,
				);
				assert.isFalse(h.github.unread(h.githubRepo, number), where);
			}
		}),
	);
});
