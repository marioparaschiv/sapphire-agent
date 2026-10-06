import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { transcriptEntries as entries } from './claude-transcript-fixture.ts';
import { type Harness, makeHarness, type StartedRunSeed } from './test-harness.ts';

const statuses = (h: Harness) => h.runs.pipe(Effect.map((runs) => runs.map((run) => run.status)));

const markers = (h: Harness, identifier: string) => h.notices(identifier).map(({ marker }) => marker);

const question = '⏺ The sync needs a conflict rule.\n\n❯ Which should win, local or remote?';

const replyTo = 'hivemind-ts-59';

// A run started by another Claude session, whose agent asked that session a question by message and ended its turn.
const askedByMessage = (h: Harness, seed: Partial<StartedRunSeed> = {}) =>
	Effect.gen(function* () {
		const started = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: `⏺ SendMessage(${replyTo})\n  ⎿  Sent`, replyTo, ...seed });
		const session = { id: started.run.session.id, cwd: started.run.worktreePath };
		const asked = [
			...entries.prompt(session, `/orchestrate Linear epic TEST-10 autonomously, reply-to ${replyTo}`),
			...entries.text(session, 'The sync needs a conflict rule before I can write the merge step.'),
			...entries.sentMessage(session, replyTo, 'TEST-10: Which should win on a conflict,\nlocal or remote?'),
			...entries.text(session, `Asked ${replyTo}; waiting for the reply.`),
		];

		h.writeTranscript(session, asked);

		return { ...started, session, asked };
	});

describe('monitoring', () => {
	it.effect('flags an agent that sits quiet without a result file and without a topic as awaitingInput, once, also across a restart', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: question });

			yield* h.tick;
			yield* TestClock.adjust('179 seconds');
			yield* h.tick;
			assert.deepStrictEqual(markers(h, 'TEST-10'), []);

			// idle to done is still quiet, so the timer keeps running.
			h.herdr.setAgentStatus(run.paneId, 'done');
			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const [flag] = h.notices('TEST-10');

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['awaitingInput:0-0']);
			assert.match(flag.text, /^⏸ \*\*TEST-10 needs input\*\*: the agent finished its turn 3 min ago without writing its result file\./);
			assert.include(flag.text, 'Which should win, local or remote?');
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
		}),
	);

	it.effect("asks the question of a run in its epic's topic, once, also across a restart", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: question });

			h.telegram.write({ from: h.telegramUser, text: 'hi' });
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;
			yield* h.restart;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const [topic] = h.telegram.topics().filter(({ title }) => title !== '📁 Test');

			assert.deepStrictEqual(
				h.telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[{ text: `⏸ The agent waits for input\n${question}\nWrite here to answer; it is typed into the agent.`, topicId: topic.topicId }],
			);
			assert.deepStrictEqual([h.linear.comments(epic.id), h.linear.labelNames(epic.id), h.notices('TEST-10')], [[], [], []]);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
			assert.strictEqual(topic.title, '⏸ TEST-10 Plugin settings sync');
		}),
	);

	it.effect("asks the requesting session first, then the epic's topic with the agent's message", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });

			h.telegram.write({ from: h.telegramUser, text: 'hi' });

			const { epic } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('599 seconds');
			yield* h.tick;
			assert.deepStrictEqual([h.telegram.sent, yield* statuses(h)], [[], ['running']]);

			yield* TestClock.adjust('1 second');
			yield* h.tick;

			const [topic] = h.telegram.topics().filter(({ title }) => title !== '📁 Test');

			assert.deepStrictEqual(
				h.telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[{ text: '⏸ The agent waits for input\nTEST-10: Which should win on a conflict,\nlocal or remote?\nWrite here to answer; it is typed into the agent.', topicId: topic.topicId }],
			);
			assert.deepStrictEqual([h.linear.comments(epic.id), h.linear.labelNames(epic.id), h.notices('TEST-10')], [[], [], []]);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
		}),
	);

	it.effect('nudges an agent whose pane stopped changing once, then flags it as stale, keeping its tab', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ staleAfterSeconds: 600, nudgeGraceSeconds: 600 });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', tail: '✻ Thinking… (12s · ↓ 3.1k tokens)' });

			yield* h.tick;
			// Only the spinner and its counters change: that is not progress.
			h.herdr.setTail(run.paneId, '✶ Thinking… (58s · ↓ 3.4k tokens)');
			yield* TestClock.adjust('10 minutes');
			yield* h.tick;
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.sentKeys(), [{ paneId: run.paneId, keys: ['esc'] }]);
			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'continue' }]);
			assert.deepStrictEqual(markers(h, 'TEST-10'), []);

			yield* TestClock.adjust('10 minutes');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), [`stale:0-${10 * 60_000}`]);
			assert.match(h.notices('TEST-10')[0].text, /^🔴 \*\*TEST-10 looks stuck\*\*: the agent has shown no new output for 20 min, even after a nudge/);
			assert.deepStrictEqual(yield* statuses(h), ['stale']);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
			assert.strictEqual(h.herdr.sentKeys().length, 1);

			// New output ends the stale episode.
			h.herdr.setTail(run.paneId, '⏺ Wrote src/sync/merge.ts');
			yield* h.tick;
			assert.deepStrictEqual(yield* statuses(h), ['running']);
		}),
	);

	it.effect('flags an agent that exited as error once, then closes its tab', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', tail: '$ claude\nSegmentation fault' });

			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['error:0']);
			assert.match(h.notices('TEST-10')[0].text, /^🔴 \*\*TEST-10 stopped\*\*: the agent exited without writing its result file[\s\S]*Segmentation fault/);
			assert.deepStrictEqual(h.herdr.closedTabs(), [run.tabId]);
			assert.deepStrictEqual(yield* statuses(h), ['error']);
		}),
	);

	it.effect('flags an agent whose tab vanished as error once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			h.herdr.removeTab(run.tabId);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['error:0']);
			assert.include(h.notices('TEST-10')[0].text, 'disappeared (its tab was closed or herdr restarted)');
			assert.deepStrictEqual(yield* statuses(h), ['error']);
		}),
	);

	it.effect('flags a run over the wall-clock cap once and lets it keep running', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxRunSeconds: 3600 });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			for (const file of ['api', 'cache', 'client', 'config', 'db', 'events', 'hooks', 'index', 'jobs', 'merge', 'queue', 'routes', 'schema', 'store', 'sync']) {
				h.herdr.setTail(run.paneId, `⏺ Wrote src/sync/${file}.ts`);
				yield* h.tick;
				yield* TestClock.adjust('5 minutes');
			}

			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['overCap:0']);
			assert.match(h.notices('TEST-10')[0].text, /^⏰ \*\*TEST-10 is over the time cap\*\*: 60 min, cap 60 min\. It keeps running\./);
			assert.deepStrictEqual(yield* statuses(h), ['running']);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
		}),
	);

	it.effect('reads the agent state from herdr on every poll, so a dropped event changes nothing', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;
			// No AgentStatusChanged event is emitted: it was dropped.
			h.herdr.setAgentStatus(run.paneId, 'done');
			yield* TestClock.adjust('30 seconds');
			yield* h.tick;

			const [tracked] = yield* h.runs;

			assert.deepStrictEqual([tracked.agentStatus, tracked.agentStatusSince], ['done', 30_000]);
		}),
	);

	it.effect('leaves a run that asked by message alone for staleAfterSeconds, then, without a topic, flags its question in one line, once, also across a restart', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { epic } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('599 seconds');
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), []);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), []);
			assert.deepStrictEqual([h.herdr.sentKeys(), h.herdr.prompts()], [[], []]);
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(
				h.notices('TEST-10').map(({ marker, text }) => [marker, text]),
				[['awaitingInput:0-0', '❓ **TEST-10 asks:** Which should win on a conflict, local or remote?\nNext: Answer the agent in its tab.']],
			);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
		}),
	);

	it.effect('stops waiting for staleAfterSeconds once the reply comes by message, and flags the run as awaitingInput as before', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { session, asked } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('5 minutes');
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), []);

			h.writeTranscript(session, [...asked, ...entries.peerMessage(session, replyTo, 'TEST-10: Remote wins.')]);
			yield* h.tick;

			const [flagged] = h.notices('TEST-10');

			assert.isTrue(flagged.text.startsWith('⏸ **TEST-10 needs input**'));
			assert.deepStrictEqual(markers(h, 'TEST-10'), ['awaitingInput:0-0']);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
		}),
	);

	it.effect('asks after staleAfterSeconds when that comes before awaitingInputAfterSeconds', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 600, staleAfterSeconds: 180 });

			yield* askedByMessage(h);
			yield* h.tick;
			yield* TestClock.adjust('180 seconds');
			yield* h.tick;

			assert.isTrue(h.notices('TEST-10')[0].text.startsWith('❓ **TEST-10 asks:** Which should win on a conflict, local or remote?'));
		}),
	);

	it.effect('flags a run with a reply-to as awaitingInput as before once its message was answered', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { session, asked } = yield* askedByMessage(h, { tail: question });

			h.writeTranscript(session, [...asked, ...entries.peerMessage(session, replyTo, 'TEST-10: Remote wins.'), ...entries.text(session, 'The sync needs a second conflict rule.')]);
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['awaitingInput:0-0']);
			assert.include(h.notices('TEST-10')[0].text, 'Which should win, local or remote?');
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
		}),
	);
});
