import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const ownedTabs = (h: Harness) => h.herdr.tabs().filter((tab) => /^[A-Z]+-\d+ /.test(tab.label));

// The run as dispatch leaves it, ready to compare across harnesses.
const started = (h: Harness) =>
	Effect.gen(function* () {
		const runs = yield* h.runs;

		return {
			runs: runs.map((run) => [run.identifier, run.status, run.worktreePath, run.tabId === null ? null : 'tab']),
			worktrees: h.worktrees(),
			tabs: ownedTabs(h).map((tab) => [tab.label, Option.getOrNull(tab.agent), tab.agentStatus]),
			starts: h.herdr.starts().map((start) => start.name),
		};
	});

describe('dispatch', () => {
	it.effect('starts a ready epic: one worktree, one tab running Claude on /orchestrate, the epic in Implementing', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;

			const worktree = join(h.dir, 'worktrees', 'repo', 'mario-test-10-plugin-settings-sync');
			const [tab] = ownedTabs(h);

			assert.deepStrictEqual(yield* started(h), {
				runs: [['TEST-10', 'running', worktree, 'tab']],
				worktrees: [worktree],
				tabs: [['TEST-10 Plugin settings sync', 'claude', 'working']],
				starts: ['test-10'],
			});
			assert.deepStrictEqual(h.herdr.starts(), [
				{
					paneId: tab.paneId,
					name: 'test-10',
					prompt: '/orchestrate Linear epic TEST-10 autonomously',
					args: [],
				},
			]);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			assert.isTrue(JSON.parse(readFileSync(join(h.dir, 'claude.json'), 'utf8')).projects[worktree].hasTrustDialogAccepted);

			yield* h.tick;
			assert.deepStrictEqual(h.herdr.starts().length, 1);
		}),
	);

	it.effect('starts an epic without sub-issues on /orchestrate inline', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-11', title: 'Fix the file leak', subIssues: 0 });

			yield* h.tick;

			assert.deepStrictEqual(
				h.herdr.starts().map((start) => start.prompt),
				['/orchestrate Linear epic TEST-11 inline autonomously'],
			);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
		}),
	);

	it.effect('resumes after a crash before any journal write without a second worktree, tab or start', () =>
		Effect.gen(function* () {
			const crashPoints: Array<number> = [];

			for (let nth = 1; ; nth += 1) {
				const h = yield* makeHarness();
				const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

				// The workspace exists already, as in production.
				h.herdr.addTab({ label: 'notes', agent: null });
				h.crashAtJournalWrite(nth);
				yield* h.tick;

				if (!h.crashed()) {
					break;
				}

				crashPoints.push(nth);
				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				const { runs, worktrees, tabs, starts } = yield* started(h);

				assert.deepStrictEqual(
					{ runs: runs.map(([identifier, status]) => [identifier, status]), worktrees: worktrees.length, tabs, starts },
					{ runs: [['TEST-10', 'running']], worktrees: 1, tabs: [['TEST-10 Plugin settings sync', 'claude', 'working']], starts: ['test-10'] },
					`crash before journal write ${nth}`,
				);
				assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
				assert.deepStrictEqual(
					h.herdr.tabs().map((tab) => tab.label),
					['notes', 'TEST-10 Plugin settings sync'],
				);
				assert.deepStrictEqual(h.herdr.closedTabs(), [], `crash before journal write ${nth}`);
			}

			// The claim, the worktree, the tab and the confirmed start each end with a journal write.
			assert.deepStrictEqual(crashPoints, [1, 2, 3, 4]);
		}),
	);

	it.effect('resumes after a crash right after opening the tab or starting Claude', () =>
		Effect.gen(function* () {
			// With the workspace in place, the herdr writes of a start are: create the tab, start Claude.
			for (const nth of [1, 2]) {
				const h = yield* makeHarness();

				h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });
				h.herdr.addTab({ label: 'notes', agent: null });
				h.herdr.crashAfterWrite(nth, new Transient({ message: 'herdr went away' }));
				yield* h.tick;
				yield* h.restart;
				yield* h.tick;

				const { runs, worktrees, tabs, starts } = yield* started(h);

				assert.deepStrictEqual(
					{ runs: runs.map(([identifier, status]) => [identifier, status]), worktrees: worktrees.length, tabs, starts },
					{ runs: [['TEST-10', 'running']], worktrees: 1, tabs: [['TEST-10 Plugin settings sync', 'claude', 'working']], starts: ['test-10'] },
					`crash after herdr write ${nth}`,
				);
			}
		}),
	);

	it.effect('keeps to maxInFlight and starts the next epic in Linear order once a slot frees', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 1 });
			const second = h.linear.addEpic({ identifier: 'TEST-11', title: 'Second', sortOrder: 2 });
			const first = h.linear.addEpic({ identifier: 'TEST-10', title: 'First', sortOrder: 1 });

			yield* h.tick;
			yield* h.tick;
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.identifier, run.status]),
				[['TEST-10', 'running']],
			);
			assert.strictEqual(h.linear.stateName(second.id), 'Ready For Agent');

			// The first agent exits: its run is flagged as error, which frees its slot.
			const [tab] = ownedTabs(h);

			h.herdr.setAgent(tab.paneId, null);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.identifier, run.status]),
				[
					['TEST-10', 'error'],
					['TEST-11', 'running'],
				],
			);
			assert.strictEqual(h.linear.stateName(first.id), 'Implementing');
			assert.strictEqual(h.linear.stateName(second.id), 'Implementing');
		}),
	);

	it.effect('claims nothing while paused', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.pausedTick;
			assert.deepStrictEqual(yield* h.runs, []);

			yield* h.tick;
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
		}),
	);

	it.effect('flags a run that is not confirmed running within the start timeout, once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ startTimeoutSeconds: 300 });
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const herdrDown = new Transient({ message: 'herdr tab create: server_not_running' });

			h.herdr.addTab({ label: 'notes', agent: null });

			for (let tick = 0; tick < 3; tick += 1) {
				h.herdr.failWrite(1, herdrDown);
				yield* h.tick;
				yield* TestClock.adjust('100 seconds');
			}

			assert.deepStrictEqual(h.epicMarkers(epic.id), []);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['claimed'],
			);

			yield* h.tick;
			yield* TestClock.adjust('100 seconds');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['startFailed:0']);
			assert.match(h.linear.comments(epic.id)[0].body, /couldn't start an agent for this epic: the agent was not confirmed running within 300 s/);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['error'],
			);
			assert.deepStrictEqual(h.herdr.starts(), []);
			assert.strictEqual(h.linear.stateName(epic.id), 'Ready For Agent');
		}),
	);

	it.effect('flags a start where Claude does not come up, with the pane tail', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			h.herdr.setStartBehaviour('no-agent');
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['startFailed:0']);
			assert.match(h.linear.comments(epic.id)[0].body, /Claude did not start in \S+: no agent is running/);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['error'],
			);
		}),
	);
});
