import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Refused } from './ctl.ts';
import { type Harness, makeHarness } from './test-harness.ts';

// What `ctl.sh status` says is still waiting.
const waiting = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('request '))));

describe('requests', () => {
	it.effect('a stop ends the run and closes its tab even while the agent works, and a second one is dropped', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });

			assert.deepStrictEqual(yield* h.ctl('stop', 'test-10'), ["TEST-10's run is stopped and its tab closed on the next tick"]);
			yield* h.ctl('stop', 'TEST-10');
			assert.deepStrictEqual(yield* waiting(h), ['request 1: stop TEST-10', 'request 2: stop TEST-10']);

			yield* h.tick;

			assert.deepStrictEqual((yield* h.runs).map(({ status }) => status), ['ended']);
			assert.deepStrictEqual(h.herdr.closedTabs(), [run.tabId]);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			assert.deepStrictEqual(yield* waiting(h), ['request 2: stop TEST-10']);

			yield* h.tick;

			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(yield* h.ctl('stop', 'TEST-10').pipe(Effect.flip), new Refused({ message: 'TEST-10 has no run in flight' }));
		}),
	);

	it.effect("a message is typed into the run's agent once, and one the agent refuses is dropped", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			assert.deepStrictEqual(yield* h.ctl('send', 'TEST-10', 'Use', 'the', 'existing', 'retry', 'helper.'), ["the message is typed into TEST-10's agent on the next tick"]);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Use the existing retry helper.' }]);

			h.herdr.setAgentStatus(run.paneId, 'blocked');
			yield* h.ctl('send', 'TEST-10', 'Answer yes.');
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Use the existing retry helper.' }]);
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(yield* h.ctl('send', 'TEST-11', 'Hi.').pipe(Effect.flip), new Refused({ message: 'TEST-11 has no agent running' }));
		}),
	);

	it.effect('drops a follow-up request once the epic has no run left to follow up on', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });
			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName });

			h.writeResultFile(run, JSON.stringify({ summary: 'Plugin settings now sync.', replies: [], flags: [] }));
			yield* h.tick;
			yield* h.ctl('follow-up', 'TEST-10', 'Rename the sync function.');
			h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
			yield* h.tick;

			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(yield* waiting(h), ['request 1: follow-up TEST-10: Rename the sync function.']);

			yield* h.tick;

			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(h.herdr.starts(), []);
		}),
	);
});
