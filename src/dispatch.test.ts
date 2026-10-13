import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { git, makeHarness } from './test-harness.ts';

describe('dispatch', () => {
	it.effect('claims an epic dispatched with --reply-to replying to that session, as the newest dispatch asked, and drops its start requests', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 3 });

			h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync', state: 'To Do' });
			h.linear.addEpic({ identifier: 'TEST-11', title: 'Fix the file leak', state: 'To Do', subIssues: 0 });
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Rename the config', state: 'To Do' });
			yield* h.ctl('dispatch', 'TEST-10', '--reply-to', 'planning');
			yield* h.ctl('dispatch', 'TEST-11', '--reply-to', 'planning');
			yield* h.ctl('dispatch', 'TEST-11', '--reply-to', 'triage');
			yield* h.ctl('dispatch', 'TEST-12', '--reply-to', 'planning');
			yield* h.ctl('dispatch', 'TEST-12');
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
				(yield* h.t3.launches).map(({ message }) => message),
				[
					'/orchestrate Linear epic TEST-10 autonomously, reply-to planning',
					'/orchestrate Linear epic TEST-11 inline autonomously, reply-to triage',
					'/orchestrate Linear epic TEST-12 autonomously',
				],
			);

			const status = yield* h.ctl('status');

			assert.include(status[2], 'session test-10, reply-to planning, ');
			assert.notInclude(status[4], 'reply-to');
			assert.deepStrictEqual(
				status.filter((line) => line.startsWith('request')),
				[],
			);
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

			// The first agent stops with an invalid result file: its run is flagged as error, which frees its slot.
			const [run] = yield* h.runs;
			const worktreePath = h.makeT3Worktree(run.branch);

			assert.isNotNull(run.threadId);
			yield* h.t3.setWorktreePath(run.threadId, worktreePath);
			yield* h.t3.setRunStatus(run.threadId, 'completed');
			h.writeResultFile({ ...run, worktreePath }, '{ "summary": ');
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

	it.effect('frees the slot of a stale run without re-claiming its epic, and counts it again once it moves', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 2 });
			const stale = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const live = yield* h.threadRun({ identifier: 'TEST-11', title: 'Fix the file leak' });
			const statuses = h.runs.pipe(Effect.map((runs) => runs.map((run) => [run.identifier, run.status]).toSorted(([a], [b]) => a.localeCompare(b))));

			yield* h.t3.setRunStatus(stale.run.threadId, 'running');
			yield* h.t3.setRunStatus(live.run.threadId, 'running');
			yield* h.t3.addActivity(stale.run.threadId);
			yield* Effect.forEach(
				Array.from({ length: 25 }),
				() => TestClock.adjust('1 minute').pipe(Effect.andThen(h.t3.addActivity(live.run.threadId)), Effect.andThen(h.tick)),
				{ discard: true },
			);

			assert.deepStrictEqual(yield* statuses, [
				['TEST-10', 'stale'],
				['TEST-11', 'running'],
			]);

			h.linear.issue(stale.epic.id).labelIds = [];
			h.moveEpic(stale.epic.id, 'Ready For Agent');
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Rename the config' });
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses, [
				['TEST-10', 'stale'],
				['TEST-11', 'running'],
				['TEST-12', 'running'],
			]);
			assert.deepStrictEqual(
				(yield* h.t3.launches).map(({ title }) => title),
				['TEST-10 Plugin settings sync', 'TEST-11 Fix the file leak', 'TEST-12 Rename the config'],
			);
			assert.isTrue((yield* h.ctl('status')).some((line) => line.startsWith('TEST-10 stale (orchestrate), holds no slot, ')));

			const waiting = h.linear.addEpic({ identifier: 'TEST-13', title: 'Drop the old cache' });

			yield* h.t3.addActivity(stale.run.threadId);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses, [
				['TEST-10', 'running'],
				['TEST-11', 'running'],
				['TEST-12', 'running'],
			]);
			assert.strictEqual(h.linear.stateName(waiting.id), 'Ready For Agent');
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
			assert.strictEqual((yield* h.t3.launches)[0].message, '/orchestrate Linear epic TEST-10 autonomously');
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

	it.effect('flags a run whose thread is not launched within the start timeout, once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ startTimeoutSeconds: 300 });
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.rejectToken(true);
			yield* h.tick;
			yield* TestClock.adjust('299 seconds');
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier), []);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['claimed'],
			);

			yield* h.t3.rejectToken(false);
			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['startFailed:0']);
			assert.match(h.notices(epic.identifier)[0].text, /^🔴 \*\*TEST-10 didn't start\*\*: the agent was not confirmed running within 300 s/);
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['startFailed:0']);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => run.status),
				['error'],
			);
			assert.deepStrictEqual(yield* h.t3.launches, []);
			assert.strictEqual(h.linear.stateName(epic.id), 'Ready For Agent');
		}),
	);
	it.effect('starts a ready epic as one full-access T3 thread on /orchestrate in a new worktree of its branch, and records the worktree once T3 made it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;

			const [project] = yield* h.t3.projects;
			const [run] = yield* h.runs;

			assert.deepStrictEqual(project.workspaceRoot, h.repo);
			assert.deepStrictEqual(yield* h.t3.launches, [
				{
					projectId: project.id,
					title: 'TEST-10 Plugin settings sync',
					message: '/orchestrate Linear epic TEST-10 autonomously',
					workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'mario/test-10-plugin-settings-sync', startFromOrigin: true },
					runtimeMode: 'full-access',
					modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
				},
			]);
			assert.isNotNull(run.threadId);
			assert.deepStrictEqual([run.status, run.threadRunId, run.worktreePath], ['running', `run:thread:${run.threadId}:ordinal:1`, null]);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');

			const path = h.makeT3Worktree(run.branch);

			yield* h.t3.setWorktreePath(run.threadId, path);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((found) => [found.status, found.threadId, found.worktreePath]),
				[['running', run.threadId, path]],
			);
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);

	it.effect('starts an epic without sub-issues on /orchestrate inline, and one with a worktree already on its branch in that worktree', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			h.linear.addEpic({ identifier: 'TEST-11', title: 'Fix the file leak', subIssues: 0 });
			const path = h.makeT3Worktree('mario/test-11-fix-the-file-leak');

			writeFileSync(join(git(path, 'rev-parse', '--absolute-git-dir'), 'sapphire-agent-result.json'), '{"summary":"An earlier run.","replies":[],"flags":[]}');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.t3.launches).map(({ message, workspaceStrategy }) => [message, workspaceStrategy]),
				[['/orchestrate Linear epic TEST-11 inline autonomously', { type: 'existing_worktree', worktreePath: path, branch: 'mario/test-11-fix-the-file-leak' }]],
			);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.worktreePath]),
				[['running', path]],
			);
			assert.isFalse(existsSync(join(git(path, 'rev-parse', '--absolute-git-dir'), 'sapphire-agent-result.json')));
		}),
	);

	it.effect('launches one thread when the process dies at any journal write of the start, finding the launched thread by its title after the restart', () =>
		Effect.gen(function* () {
			const crashPoints: Array<number> = [];

			for (let nth = 1; ; nth += 1) {
				const h = yield* makeHarness();
				const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

				h.crashAtJournalWrite(nth);
				yield* h.tick;

				if (!h.crashed()) {
					break;
				}

				crashPoints.push(nth);
				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				const launches = yield* h.t3.launches;
				const [run] = yield* h.runs;

				assert.lengthOf(launches, 1, `crash before journal write ${nth}`);
				assert.isNotNull(run.threadId);
				assert.isTrue(Option.isSome(yield* h.t3.thread(run.threadId)), `crash before journal write ${nth}`);
				assert.deepStrictEqual([run.status, run.threadRunId], ['running', `run:thread:${run.threadId}:ordinal:1`], `crash before journal write ${nth}`);
				assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			}

			// The claim, the launched thread and the confirmed start each end with a journal write.
			assert.deepStrictEqual(crashPoints, [1, 2, 3]);
		}),
	);

	it.effect('keeps a run in flight across a restart without a second thread, and a new claim after it ended launches a new one', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;

			const [before] = yield* h.runs;

			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* h.runs, [before]);
			assert.lengthOf(yield* h.t3.launches, 1);

			assert.isNotNull(before.threadId);
			yield* h.t3.setRunStatus(before.threadId, 'failed');
			h.moveEpic(epic.id, 'Ready For Agent');
			yield* TestClock.adjust('1 second');
			yield* h.tick;

			const [after] = yield* h.runs;

			assert.lengthOf(yield* h.t3.launches, 2);
			assert.notStrictEqual(after.threadId, before.threadId);
			assert.strictEqual(after.status, 'running');
		}),
	);

	it.effect('fails the start once when T3 refuses the launch, leaving the epic in Ready for a retry', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setLaunchOutcome({ code: 'runtime_mode_escalation_denied', message: 'The token may not launch full-access threads.' });
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['startFailed:0']);
			assert.include(h.notices(epic.identifier)[0].text, 'T3 refused t3_thread_launch: The token may not launch full-access threads. (runtime_mode_escalation_denied)');
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.threadId]),
				[['error', null]],
			);
			assert.lengthOf(yield* h.t3.launches, 1);
			assert.notInclude(yield* h.t3.calls, 't3_thread_interrupt');
			assert.strictEqual(h.linear.stateName(epic.id), 'Ready For Agent');
		}),
	);

	it.effect("fails the start without launching when T3's settings have no default model", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const settingsFile = join(h.dir, 't3-settings.json');

			writeFileSync(settingsFile, JSON.stringify({ defaultAutoPull: true, branchNamePrefix: 'agent/', pullRequestMergeMethod: 'squash' }, null, 2));
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['startFailed:0']);
			assert.include(h.notices(epic.identifier)[0].text, `T3's settings in ${settingsFile} have no default model: set a default model in T3`);
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.threadId]),
				[['error', null]],
			);
			assert.notInclude(yield* h.t3.calls, 't3_thread_launch');
		}),
	);

	it.effect('fails the start of a thread whose run ended at once, and interrupts the thread', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setLaunchOutcome({ status: 'failed' });
			yield* h.tick;

			const [run] = yield* h.runs;

			assert.include(h.notices(epic.identifier)[0].text, `the run of T3 thread ${run.threadId} ended at once: failed`);
			assert.deepStrictEqual(run.status, 'error');
			assert.include(yield* h.t3.calls, 't3_thread_interrupt');
			assert.strictEqual(h.linear.stateName(epic.id), 'Ready For Agent');
		}),
	);

	it.effect("reads the result file only once the thread's run completed, then posts it and ends the run", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.tick;

			const [run] = yield* h.runs;
			const path = h.makeT3Worktree(run.branch);

			assert.isNotNull(run.threadId);
			yield* h.t3.setWorktreePath(run.threadId, path);
			yield* h.t3.setRunStatus(run.threadId, 'running');
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });
			writeFileSync(join(git(path, 'rev-parse', '--absolute-git-dir'), 'sapphire-agent-result.json'), JSON.stringify({ summary: 'Plugin settings now sync.', replies: [], flags: [] }));
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((found) => [found.status, found.result]),
				[['running', null]],
			);

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((found) => [found.status, found.worktreePath, found.result?.summary]),
				[['ended', path, 'Plugin settings now sync.']],
			);
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['pullRequestOpened:https://github.com/test/repo/pull/1', 'summary:0']);
			assert.strictEqual(h.linear.stateName(epic.id), 'To Review');
		}),
	);
});
