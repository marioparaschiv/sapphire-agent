import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { type Harness, makeHarness } from './test-harness.ts';

const titles = (h: Harness) => h.telegram.topics().map(({ title }) => title);

const sentTexts = (h: Harness) => h.telegram.sent.map(({ text }) => text);

// The user has written to the bot, so it may write to them.
const greet = (h: Harness) => h.telegram.write({ from: h.telegramUser, text: 'hi' });

describe('topics', () => {
	it.effect('gives a dispatched epic exactly one topic, also across restarts', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			greet(h);
			h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);
			assert.strictEqual(h.telegram.topicsCreated(), 1);
			assert.deepStrictEqual(
				h.telegram.topics().map(({ chatId }) => chatId),
				[h.telegramUser],
			);
		}),
	);

	it.effect('never gives a topic to an epic that is not running', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			greet(h);
			h.linear.addEpic({ identifier: 'TEST-10', title: 'Waiting in Ready' });
			h.linear.addEpic({ identifier: 'TEST-11', title: 'Waiting for review', state: 'To Review' });
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Shipped long ago', state: 'Shipped' });
			yield* h.pausedTick;

			assert.deepStrictEqual(titles(h), []);
		}),
	);

	it.effect("names the topic by the run's state as it moves between working, awaiting input and error", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working', tail: '⏺ Reading src/sync' });

			greet(h);
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);

			h.herdr.setAgentStatus(run.paneId, 'idle');
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['⏸ TEST-10 Plugin settings sync']);

			h.herdr.setAgentStatus(run.paneId, 'working');
			h.herdr.setTail(run.paneId, '⏺ Writing src/sync/merge.ts');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);

			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🔴 TEST-10 Plugin settings sync']);
			assert.strictEqual(h.telegram.topicsCreated(), 1);
		}),
	);

	it.effect('posts an opened PR once in the topic and once in the main chat', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });

			greet(h);
			yield* h.tick;

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const [topic] = h.telegram.topics();

			assert.deepStrictEqual(
				h.telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[
					{ text: `PR opened: ${pullRequest.url}`, topicId: topic.topicId },
					{ text: `TEST-10 Plugin settings sync: PR opened ${pullRequest.url}`, topicId: null },
				],
			);
		}),
	);

	it.effect('sums up a shipped epic in the Done topic and deletes its topic, and a stopped one is only deleted', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 2 });
			const shipped = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working', subIssues: 3 });

			yield* h.startedRun({ identifier: 'TEST-11', title: 'Dark mode', agentStatus: 'working' });
			greet(h);
			yield* h.tick;

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: shipped.run.branch, author: 'marioparaschiv' });

			yield* h.tick;
			yield* h.ctl('stop', 'TEST-11');
			h.moveEpic(shipped.epic.id, 'Shipped');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['✅ Done']);
			assert.deepStrictEqual(sentTexts(h).slice(2), [`TEST-10 Plugin settings sync · ${pullRequest.url} · 3 slices`]);
			assert.strictEqual(h.telegram.sent[2].topicId, h.telegram.topics()[0].topicId);
		}),
	);

	it.effect('keeps the topic of an epic whose run ended while it waits for review, and deletes it when the epic is moved back', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run, epic } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });

			greet(h);
			yield* h.tick;
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });
			h.writeResultFile(run, JSON.stringify({ summary: 'Settings sync.', replies: [], flags: [] }));
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['👀 TEST-10 Plugin settings sync']);

			h.moveEpic(epic.id, 'To Do');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), []);
		}),
	);
});
