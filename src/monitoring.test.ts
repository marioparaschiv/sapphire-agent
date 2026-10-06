import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { transcriptEntries as entries } from './claude-transcript-fixture.ts';
import { parseMarker, renderMarker } from './markers.ts';
import { type Harness, makeHarness, type StartedRunSeed } from './test-harness.ts';

const statuses = (h: Harness) => h.runs.pipe(Effect.map((runs) => runs.map((run) => run.status)));

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
	it.effect('flags an agent that sits quiet without a result file as awaitingInput, once, also across a restart', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: question });

			yield* h.tick;
			yield* TestClock.adjust('179 seconds');
			yield* h.tick;
			assert.deepStrictEqual(h.epicMarkers(epic.id), []);

			// idle to done is still quiet, so the timer keeps running.
			h.herdr.setAgentStatus(run.paneId, 'done');
			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const [flag] = h.linear.comments(epic.id);
			const [flagged] = yield* h.runs;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.match(flag.body, /^\*\*sapphire-agent\*\* \(`awaitingInput`\): the agent finished its turn 3 min ago before writing its result file\./);
			assert.include(flag.body, 'Which should win, local or remote?');
			assert.deepStrictEqual([flagged.status, flagged.questionCommentId], ['awaitingInput', flag.id]);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
		}),
	);

	it.effect("asks the question of a run without a requesting session in its epic's topic instead of on Linear, once, also across a restart", () =>
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
				[{ text: `⏸ Waiting for input:\n\n${question}\n\nWrite here to answer; it is typed into the agent.`, topicId: topic.topicId }],
			);
			assert.deepStrictEqual([h.linear.comments(epic.id), h.linear.labelNames(epic.id)], [[], []]);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
			assert.strictEqual(topic.title, '⏸ TEST-10 Plugin settings sync');
		}),
	);

	it.effect('still asks the requesting session of a run that has a topic, then Linear, never the topic', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });

			h.telegram.write({ from: h.telegramUser, text: 'hi' });

			const { epic } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('599 seconds');
			yield* h.tick;
			assert.deepStrictEqual([h.linear.comments(epic.id), yield* statuses(h)], [[], ['running']]);

			yield* TestClock.adjust('1 second');
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.strictEqual(h.telegram.topics().length, 2);
			assert.deepStrictEqual(h.telegram.sent, []);
		}),
	);

	it.effect('nudges an agent whose pane stopped changing once, then flags it as stale, keeping its tab', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ staleAfterSeconds: 600, nudgeGraceSeconds: 600 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', tail: '✻ Thinking… (12s · ↓ 3.1k tokens)' });

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
			assert.deepStrictEqual(h.epicMarkers(epic.id), []);

			yield* TestClock.adjust('10 minutes');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), [`stale:0-${10 * 60_000}`]);
			assert.match(h.linear.comments(epic.id)[0].body, /has shown no new output for 20 min, even after a nudge/);
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
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', tail: '$ claude\nSegmentation fault' });

			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['error:0']);
			assert.match(h.linear.comments(epic.id)[0].body, /\(`error`\): the agent exited before writing its result file[\s\S]*Segmentation fault/);
			assert.deepStrictEqual(h.herdr.closedTabs(), [run.tabId]);
			assert.deepStrictEqual(yield* statuses(h), ['error']);
		}),
	);

	it.effect('flags an agent whose tab vanished as error once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			h.herdr.removeTab(run.tabId);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['error:0']);
			assert.include(h.linear.comments(epic.id)[0].body, 'disappeared (its tab was closed or herdr restarted)');
			assert.deepStrictEqual(yield* statuses(h), ['error']);
		}),
	);

	it.effect('flags a run over the wall-clock cap once and lets it keep running', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxRunSeconds: 3600 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			for (const file of ['api', 'cache', 'client', 'config', 'db', 'events', 'hooks', 'index', 'jobs', 'merge', 'queue', 'routes', 'schema', 'store', 'sync']) {
				h.herdr.setTail(run.paneId, `⏺ Wrote src/sync/${file}.ts`);
				yield* h.tick;
				yield* TestClock.adjust('5 minutes');
			}

			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['overCap:0']);
			assert.match(h.linear.comments(epic.id)[0].body, /the run has been going for 60 min, over the 60 min cap\. It keeps running\./);
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

	it.effect('types a reply to the question into the pane once and marks it delivered; other replies are ignored', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: question });

			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;

			const [flagged] = yield* h.runs;
			const unrelated = h.linear.addComment(epic.id, 'Note for later: check the iOS build.');

			h.linear.addComment(epic.id, 'Not this one.', { parentId: unrelated.id });

			const reply = h.linear.addComment(epic.id, 'Remote wins.\nKeep a backup of local.', { parentId: flagged.questionCommentId ?? '' });

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Remote wins. Keep a backup of local.' }]);
			assert.deepStrictEqual(
				h.linear.comments(epic.id).map((comment) => [comment.id === flagged.questionCommentId ? 'question' : comment.body.split('\n')[0], comment.reactions]),
				[
					['question', []],
					['Note for later: check the iOS build.', []],
					['Not this one.', []],
					['Remote wins.', ['white_check_mark']],
				],
			);
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.deepStrictEqual((yield* h.runs)[0].deliveredReplyIds, [reply.id]);
		}),
	);

	it.effect('posts a notice under the question when the reply cannot be typed, once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'blocked', tail: 'Allow edit to src/sync/merge.ts? (y/n)' });

			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;

			const [flagged] = yield* h.runs;
			const question = flagged.questionCommentId ?? '';
			const reply = h.linear.addComment(epic.id, 'Yes, allow it.', { parentId: question });

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const notices = h.linear.comments(epic.id).filter((comment) => comment.parentId === question && comment.id !== reply.id);

			assert.deepStrictEqual(h.herdr.prompts(), []);
			assert.deepStrictEqual(
				notices.map((notice) => Option.map(parseMarker(notice.body), (marker) => `${marker.purpose}:${marker.key}`)),
				[Option.some(`replyFailed:${reply.id}`)],
			);
			assert.match(notices[0].body, /couldn't type your last reply into the agent's pane: .*agent_blocked/);
			assert.deepStrictEqual(h.linear.comments(epic.id).find((comment) => comment.id === reply.id)?.reactions, []);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
		}),
	);

	it.effect('leaves a run that asked by message alone for staleAfterSeconds, then asks its question on Linear in one line, once, also across a restart', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { epic, run } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('599 seconds');
			yield* h.tick;

			assert.deepStrictEqual(h.linear.comments(epic.id), []);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), []);
			assert.deepStrictEqual([h.herdr.sentKeys(), h.herdr.prompts()], [[], []]);
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const [asked] = h.linear.comments(epic.id);
			const [flagged] = yield* h.runs;

			assert.strictEqual(asked.body, `TEST-10 asks: Which should win on a conflict, local or remote?\n\n${renderMarker({ identifier: 'TEST-10', purpose: 'awaitingInput', key: '0-0' })}`);
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.deepStrictEqual([flagged.status, flagged.questionCommentId], ['awaitingInput', asked.id]);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);

			const reply = h.linear.addComment(epic.id, 'Remote wins.', { parentId: asked.id });

			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Remote wins.' }]);
			assert.deepStrictEqual(h.linear.comments(epic.id).find((comment) => comment.id === reply.id)?.reactions, ['white_check_mark']);
		}),
	);

	it.effect('stops waiting for staleAfterSeconds once the reply comes by message, and flags the run as awaitingInput as before', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { epic, session, asked } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('5 minutes');
			yield* h.tick;

			assert.deepStrictEqual(h.linear.comments(epic.id), []);

			h.writeTranscript(session, [...asked, ...entries.peerMessage(session, replyTo, 'TEST-10: Remote wins.')]);
			yield* h.tick;

			const [flagged] = h.linear.comments(epic.id);

			assert.isFalse(flagged.body.startsWith('TEST-10 asks:'));
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
		}),
	);

	it.effect('asks on Linear after staleAfterSeconds when that comes before awaitingInputAfterSeconds', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 600, staleAfterSeconds: 180 });
			const { epic } = yield* askedByMessage(h);

			yield* h.tick;
			yield* TestClock.adjust('180 seconds');
			yield* h.tick;

			const [asked] = h.linear.comments(epic.id);

			assert.isTrue(asked.body.startsWith('TEST-10 asks: Which should win on a conflict, local or remote?'));
		}),
	);

	it.effect('flags a run with a reply-to as awaitingInput as before once its message was answered', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180, staleAfterSeconds: 600 });
			const { epic, session, asked } = yield* askedByMessage(h, { tail: question });

			h.writeTranscript(session, [...asked, ...entries.peerMessage(session, replyTo, 'TEST-10: Remote wins.'), ...entries.text(session, 'The sync needs a second conflict rule.')]);
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['awaitingInput:0-0']);
			assert.include(h.linear.comments(epic.id)[0].body, 'Which should win, local or remote?');
			assert.deepStrictEqual(yield* statuses(h), ['awaitingInput']);
		}),
	);
});
