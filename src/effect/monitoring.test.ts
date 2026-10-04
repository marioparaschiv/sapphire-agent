import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { parseMarker } from './markers.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const markers = (h: Harness, issueId: string) =>
	h.linear.comments(issueId).flatMap((comment) => Option.toArray(Option.map(parseMarker(comment.body), (marker) => `${marker.purpose}:${marker.key}`)));

const statuses = (h: Harness) => h.runs.pipe(Effect.map((runs) => runs.map((run) => run.status)));

const question = '⏺ The sync needs a conflict rule.\n\n❯ Which should win, local or remote?';

describe('monitoring', () => {
	it.effect('flags an agent that sits quiet without a result file as awaitingInput, once, also across a restart', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: question });

			yield* h.tick;
			yield* TestClock.adjust('179 seconds');
			yield* h.tick;
			assert.deepStrictEqual(markers(h, epic.id), []);

			// idle to done is still quiet, so the timer keeps running.
			h.herdr.setAgentStatus(run.paneId, 'done');
			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const [flag] = h.linear.comments(epic.id);
			const [flagged] = yield* h.runs;

			assert.deepStrictEqual(markers(h, epic.id), ['awaitingInput:0-0']);
			assert.match(flag.body, /^\*\*herdr-linear\*\* \(`awaitingInput`\): the agent finished its turn 3 min ago before writing its result file\./);
			assert.include(flag.body, 'Which should win, local or remote?');
			assert.deepStrictEqual([flagged.status, flagged.questionCommentId], ['awaitingInput', flag.id]);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
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
			assert.deepStrictEqual(markers(h, epic.id), []);

			yield* TestClock.adjust('10 minutes');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, epic.id), [`stale:0-${10 * 60_000}`]);
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

			assert.deepStrictEqual(markers(h, epic.id), ['error:0']);
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

			assert.deepStrictEqual(markers(h, epic.id), ['error:0']);
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

			assert.deepStrictEqual(markers(h, epic.id), ['overCap:0']);
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
				h.linear.comments(epic.id).map((comment) => [comment.body.split('\n')[0], comment.reactions]),
				[
					[h.linear.comments(epic.id)[0].body.split('\n')[0], []],
					['Note for later: check the iOS build.', []],
					['Not this one.', []],
					['Remote wins.', ['white_check_mark']],
				],
			);
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
});
