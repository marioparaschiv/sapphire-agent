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
			const [run] = yield* h.runs;

			assert.isNotNull(run.session);
			assert.strictEqual(run.session.name, 'test-10');
			assert.match(run.session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
					args: ['--session-id', run.session.id, '--name', 'test-10'],
				},
			]);
			assert.strictEqual(tab.workspace, 'Test');
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

	it.effect('claims an epic started with --reply-to replying to that session, as the newest start asked, and drops its start requests', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 3 });

			h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync', state: 'To Do' });
			h.linear.addEpic({ identifier: 'TEST-11', title: 'Fix the file leak', state: 'To Do', subIssues: 0 });
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Rename the config', state: 'To Do' });
			yield* h.ctl('start', 'TEST-10', '--reply-to', 'planning');
			yield* h.ctl('start', 'TEST-11', '--reply-to', 'planning');
			yield* h.ctl('start', 'TEST-11', '--reply-to', 'triage');
			yield* h.ctl('start', 'TEST-12', '--reply-to', 'planning');
			yield* h.ctl('start', 'TEST-12');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.identifier, run.replyTo]),
				[
					['TEST-10', 'planning'],
					['TEST-11', 'triage'],
					['TEST-12', null],
				],
			);
			assert.deepStrictEqual(
				h.herdr.starts().map((start) => start.prompt),
				[
					'/orchestrate Linear epic TEST-10 autonomously, reply-to planning',
					'/orchestrate Linear epic TEST-11 inline autonomously, reply-to triage',
					'/orchestrate Linear epic TEST-12 autonomously',
				],
			);

			const status = yield* h.ctl('status');

			assert.include(status[1], 'session test-10, reply-to planning, ');
			assert.notInclude(status[3], 'reply-to');
			assert.deepStrictEqual(
				status.filter((line) => line.startsWith('request')),
				[],
			);
		}),
	);

	it.effect('resumes after a crash before any journal write without a second worktree, tab or start, in the session it was claimed with', () =>
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

				const claimed = (yield* h.runs).map((run) => run.session);

				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				const [run] = yield* h.runs;

				assert.isNotNull(run.session);
				assert.deepStrictEqual(claimed, nth === 1 ? [] : [run.session], `crash before journal write ${nth}`);
				assert.deepStrictEqual(h.herdr.starts().map(({ args }) => args), [['--session-id', run.session.id, '--name', 'test-10']], `crash before journal write ${nth}`);

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

	it.effect('waits dispatchSettleSeconds after an epic is created before claiming it, so its sub-issues are attached first', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ dispatchSettleSeconds: 60 });
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync', createdAt: new Date(0).toISOString() });

			yield* TestClock.adjust('59 seconds');
			yield* h.tick;
			assert.deepStrictEqual(yield* h.runs, []);
			assert.strictEqual(h.linear.stateName(epic.id), 'Ready For Agent');

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			assert.strictEqual(h.herdr.starts()[0].prompt, '/orchestrate Linear epic TEST-10 autonomously');
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

			assert.deepStrictEqual(h.notices(epic.identifier), []);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['claimed'],
			);

			yield* h.tick;
			yield* TestClock.adjust('100 seconds');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['startFailed:0']);
			assert.match(h.notices(epic.identifier)[0].text, /^🔴 \*\*TEST-10 didn't start\*\*: the agent was not confirmed running within 300 s/);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
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

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['startFailed:0']);
			assert.match(h.notices(epic.identifier)[0].text, /Claude did not start in \S+: no agent is running/);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['error'],
			);
		}),
	);
});
