import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { AppConfig } from './config.ts';
import { wakeForEpicEdits } from './epic-edits.ts';
import { Journal } from './journal.ts';
import { Reconciler } from './reconciler.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const sent = (h: Harness) => h.t3.sends.pipe(Effect.map((sends) => sends.map(({ threadId, message, mode, clientRequestId }) => [threadId, message, mode, clientRequestId])));

const reRead = (identifiers: string) => `\n\nRe-read ${identifiers} in Linear and adjust your work to these edits before you continue.`;

// The edits listed in the prompt the summary model got.
const listing = (prompt: string) => prompt.split('\n\n')[1];

// The epics the journal holds a snapshot of.
const snapshotted = (h: Harness) => h.epicSnapshots.pipe(Effect.map((snapshots) => snapshots.map(({ epicId }) => epicId)));

// A run whose agent works in its thread, as dispatched.
const workingRun = (h: Harness, subIssues = 2) =>
	Effect.gen(function* () {
		const threaded = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync', subIssues });

		yield* h.t3.setRunStatus(threaded.run.threadId, 'running');

		return threaded;
	});

describe('epic edits', () => {
	it.effect("sends one message with the summary of the owner's edit to the epic once the debounce window passed", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* workingRun(h);

			h.summariser.answerWith('TEST-10 now asks for sync over WebSockets instead of polling.');
			h.linear.updateIssue(epic.id, { description: 'Sync the plugin settings over WebSockets, not polling.' });
			yield* h.tick;
			yield* TestClock.adjust('59 seconds');
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), []);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), [[run.threadId, `TEST-10 now asks for sync over WebSockets instead of polling.${reRead('TEST-10')}`, 'auto', `edits-${run.claimedAt}-0`]]);
			assert.lengthOf(h.summariser.prompts(), 1);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-10 description\n  before: none\n  after: Sync the plugin settings over WebSockets, not polling.');
		}),
	);

	it.effect('reports a new sub-issue and the state, blockers, title and description of a sub-issue', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);
			const [first, second] = h.linear.subIssues(epic.id);

			h.linear.addSubIssue(epic.id, 'TEST-103', 'Migrate stored settings');
			h.linear.updateIssue(first.id, { state: 'Ready For Agent', title: 'Slice 1: the sync client', description: 'Use the shared socket.' });
			h.linear.updateIssue(second.id, { blockedBy: ['TEST-103'] });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const sends = yield* h.t3.sends;

			assert.lengthOf(sends, 1);
			assert.strictEqual(
				listing(h.summariser.prompts()[0]),
				[
					'- TEST-101 title\n  before: Slice 1\n  after: Slice 1: the sync client',
					'- TEST-101 description\n  before: none\n  after: Use the shared socket.',
					'- TEST-101 state\n  before: To Do\n  after: Ready For Agent',
					'- TEST-102 blocked by\n  before: none\n  after: TEST-103',
					'- TEST-103 "Migrate stored settings" is a new sub-issue',
				].join('\n'),
			);
			assert.isTrue(sends[0].message.endsWith(reRead('TEST-101, TEST-102, TEST-103')));
		}),
	);

	it.effect('collects several edits within the debounce window into one message, sent once they stopped', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);
			const [first] = h.linear.subIssues(epic.id);

			h.linear.updateIssue(epic.id, { title: 'Plugin settings sync over WebSockets' });
			yield* h.tick;
			yield* TestClock.adjust('30 seconds');
			h.linear.updateIssue(first.id, { description: 'Open one socket per window.' });
			yield* h.tick;
			yield* TestClock.adjust('59 seconds');
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), []);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* TestClock.adjust('5 minutes');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.deepStrictEqual(
				listing(h.summariser.prompts()[0]).split('\n').filter((line) => line.startsWith('- ')),
				['- TEST-10 title', '- TEST-101 description'],
			);
		}),
	);

	it.effect("never sends for the epic's moves, sub-issue moves to Implementing or Done, the stuck label, Linear's automations or comments, but reports any other sub-issue move", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h, 3);
			const [first, second, third] = h.linear.subIssues(epic.id);
			const stuck = h.linear.addLabel({ name: 'agent-stuck' });

			h.linear.updateIssue(first.id, { state: 'Implementing' });
			yield* h.tick;
			h.linear.updateIssue(first.id, { state: 'Done' });
			h.linear.updateIssue(epic.id, { state: 'In Review', labelIds: [stuck.id] });
			h.linear.updateIssue(second.id, { state: 'Canceled' }, 'automation');
			h.linear.addComment(epic.id, 'Slice 1 is done.');
			yield* h.tick;
			yield* TestClock.adjust('2 minutes');
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), []);
			assert.deepStrictEqual(h.summariser.prompts(), []);

			h.linear.updateIssue(third.id, { state: 'Canceled' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-103 state\n  before: To Do\n  after: Canceled');
		}),
	);

	it.effect('sends nothing when the owner reverts an edit within the debounce window', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);

			h.linear.updateIssue(epic.id, { title: 'Plugin settings sync v2' });
			yield* h.tick;
			yield* TestClock.adjust('30 seconds');
			h.linear.updateIssue(epic.id, { title: 'Plugin settings sync' });
			yield* h.tick;

			assert.deepStrictEqual((yield* h.epicSnapshots).map(({ edits }) => edits), [null]);

			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), []);
			assert.deepStrictEqual(h.summariser.prompts(), []);
		}),
	);

	it.effect('holds the edits until the run has a thread, then sends them', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* h.t3.rejectToken(true);

			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;
			h.linear.updateIssue(epic.id, { description: 'Only sync themes.' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual((yield* h.runs).map(({ status, threadId }) => [status, threadId]), [['claimed', null]]);
			assert.notInclude(yield* h.t3.calls, 't3_thread_send');
			assert.deepStrictEqual(h.summariser.prompts(), []);

			yield* h.t3.rejectToken(false);
			yield* h.tick;

			const [run] = yield* h.runs;

			assert.isNotNull(run.threadId);
			assert.deepStrictEqual((yield* sent(h)).map(([threadId]) => threadId), [run.threadId]);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-10 description\n  before: none\n  after: Only sync themes.');
		}),
	);

	it.effect("reports the owner's edit to a field an automation edited before the snapshot", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);
			const [first] = h.linear.subIssues(epic.id);

			h.linear.updateIssue(first.id, { state: 'Canceled' }, 'automation');
			yield* TestClock.adjust('10 seconds');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			h.linear.updateIssue(first.id, { state: 'Ready For Agent' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-101 state\n  before: Canceled\n  after: Ready For Agent');
		}),
	);

	it.effect("leaves out an automation's edit to a field the owner edited before the snapshot", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);
			const [first] = h.linear.subIssues(epic.id);

			h.linear.updateIssue(first.id, { state: 'Ready For Agent' });
			yield* TestClock.adjust('10 seconds');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			h.linear.updateIssue(first.id, { state: 'Canceled' }, 'automation');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.lengthOf(h.summariser.prompts(), 1);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-101 state\n  before: To Do\n  after: Ready For Agent');
		}),
	);

	it.effect('reports a sub-issue the owner took out of the epic, but not one an automation did', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);
			const [first, second] = h.linear.subIssues(epic.id);

			h.linear.updateIssue(second.id, { parentId: null }, 'automation');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual(yield* sent(h), []);

			h.linear.updateIssue(first.id, { parentId: null });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.strictEqual(listing(h.summariser.prompts()[0]), '- TEST-101 "Slice 1" is no longer a sub-issue');
		}),
	);

	it.effect('leaves a run that is no longer in flight alone', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);

			assert.deepStrictEqual(yield* snapshotted(h), [epic.id]);

			yield* h.ctl('stop', 'TEST-10');
			yield* h.tick;
			h.linear.updateIssue(epic.id, { description: 'Scope changed.' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual((yield* h.runs).map(({ status }) => status), ['ended']);
			assert.deepStrictEqual(yield* snapshotted(h), []);
			assert.deepStrictEqual(yield* sent(h), []);
			assert.deepStrictEqual(h.summariser.prompts(), []);
		}),
	);

	it.effect('catches an edit made while the service was down, with no delivery, on the first tick after it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* workingRun(h);

			yield* h.stop;
			h.linear.updateIssue(epic.id, { title: 'Plugin settings sync v2' });
			yield* h.restart;
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual((yield* sent(h)).map(([threadId]) => threadId), [run.threadId]);
		}),
	);

	it.effect('sends the edits as listed when the summary model fails', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* workingRun(h);

			h.summariser.answerWith(null);
			h.linear.updateIssue(epic.id, { description: 'Only sync themes.' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* sent(h)).map(([threadId, message]) => [threadId, message]),
				[[run.threadId, `Your epic or its sub-issues were edited in Linear:\n- TEST-10 description\n  before: none\n  after: Only sync themes.${reRead('TEST-10')}`]],
			);
		}),
	);

	it.effect('sends the message once when the process dies before the snapshot is taken again', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* workingRun(h);

			h.linear.updateIssue(epic.id, { description: 'Only sync themes.' });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			h.crashAtJournalWrite(1);
			yield* h.tick;

			assert.isTrue(h.crashed());

			yield* h.restart;
			yield* TestClock.adjust('10 seconds');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			assert.lengthOf(yield* sent(h), 1);
			assert.lengthOf(h.summariser.prompts(), 2);
		}),
	);

	it.effect('wakes the reconciler once when pending edits waited the debounce window', () =>
		Effect.gen(function* () {
			const wakes = yield* Ref.make(0);
			const journal = yield* Journal;

			yield* journal.putEpicSnapshot({
				epicId: 'issue-test-10',
				claimedAt: 0,
				takenAt: 0,
				issues: [],
				edits: [{ issueId: 'issue-test-10', identifier: 'TEST-10', field: 'title', before: 'Plugin settings sync', after: 'Plugin settings sync v2' }],
				editedAt: 10_000,
			});
			yield* Effect.forkChild(wakeForEpicEdits.pipe(Effect.provideService(Reconciler, Reconciler.of({ wake: Ref.update(wakes, (count) => count + 1), run: Effect.never }))));
			yield* TestClock.adjust('65 seconds');

			assert.strictEqual(yield* Ref.get(wakes), 0);

			yield* TestClock.adjust('5 seconds');

			assert.strictEqual(yield* Ref.get(wakes), 1);

			yield* TestClock.adjust('5 minutes');

			assert.strictEqual(yield* Ref.get(wakes), 1);
		}).pipe(Effect.provide(Layer.mergeAll(Journal.layer(':memory:'), AppConfig.layerTest('/tmp/sapphire-agent-test')))),
	);
});
