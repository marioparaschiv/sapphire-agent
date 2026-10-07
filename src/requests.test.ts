import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { Refused } from './ctl.ts';
import { type Harness, makeHarness } from './test-harness.ts';

// What `ctl.sh status` says is still waiting.
const waiting = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('request '))));

describe('requests', () => {
	it.effect("a stop interrupts the run's thread while it works and ends the run, leaving the epic where it is, and a second one is dropped", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;

			const [run] = yield* h.runs;

			assert.isNotNull(run.threadId);
			yield* h.t3.setRunStatus(run.threadId, 'running');
			assert.deepStrictEqual(yield* h.ctl('stop', 'test-10'), ["TEST-10's run is stopped and its T3 thread interrupted on the next tick"]);
			yield* h.ctl('stop', 'TEST-10');
			assert.deepStrictEqual(yield* waiting(h), ['request 1: stop TEST-10', 'request 2: stop TEST-10']);
			yield* h.tick;

			const thread = yield* h.t3.thread(run.threadId);

			assert.deepStrictEqual(
				Option.map(thread, ({ runs }) => runs.map(({ status }) => status)),
				Option.some(['interrupted']),
			);
			assert.deepStrictEqual((yield* h.runs).map(({ status }) => status), ['ended']);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			assert.deepStrictEqual(yield* waiting(h), ['request 2: stop TEST-10']);

			yield* h.tick;

			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(yield* h.ctl('stop', 'TEST-10').pipe(Effect.flip), new Refused({ message: 'TEST-10 has no run in flight' }));
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);

	it.effect("a message reaches the run's thread once: it steers the working agent, or starts a turn the run then follows", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');
			assert.deepStrictEqual(yield* h.ctl('send', 'TEST-10', 'Use', 'the', 'existing', 'helper.'), ["the message is sent to TEST-10's agent on the next tick"]);
			yield* h.tick;
			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.ctl('send', 'TEST-10', 'Also', 'update', 'the', 'docs.');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.t3.sends).map(({ threadId, message, mode, clientRequestId }) => [threadId, message, mode, clientRequestId]),
				[
					[run.threadId, 'Use the existing helper.', 'auto', 'send-1'],
					[run.threadId, 'Also update the docs.', 'auto', 'send-2'],
				],
			);
			assert.deepStrictEqual(
				(yield* h.runs).map(({ threadRunId }) => threadRunId),
				[`run:thread:${run.threadId}:ordinal:2`],
			);
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(yield* h.ctl('send', 'TEST-11', 'Hi.').pipe(Effect.flip), new Refused({ message: 'TEST-11 has no agent running' }));
		}),
	);

	it.effect('drops a follow-up request once the epic has no run left to follow up on', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch });

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			h.writeResultFile(run, JSON.stringify({ summary: 'Plugin settings now sync.', replies: [], flags: [] }));
			yield* h.tick;
			yield* h.ctl('follow-up', 'TEST-10', 'Rename the sync function.');
			h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
			yield* h.tick;

			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(yield* waiting(h), ['request 1: follow-up TEST-10: Rename the sync function.']);

			yield* h.tick;

			assert.deepStrictEqual(yield* waiting(h), []);
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);
});
