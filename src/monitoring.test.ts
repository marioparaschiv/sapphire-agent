import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { type Harness, makeHarness } from './test-harness.ts';

const statuses = (h: Harness) => h.runs.pipe(Effect.map((runs) => runs.map((run) => run.status)));

const markers = (h: Harness, identifier: string) => h.notices(identifier).map(({ marker }) => marker);

const nudges = (h: Harness) => h.t3.sends.pipe(Effect.map((sends) => sends.map(({ message, mode }) => [message, mode])));

// Ticks once a minute for `minutes`, calling `each` before every tick, as the poll and T3's wakes do.
const minuteTicks = (h: Harness, minutes: number, each: Effect.Effect<void> = Effect.void) =>
	Effect.forEach(
		Array.from({ length: minutes }),
		() => TestClock.adjust('1 minute').pipe(Effect.andThen(each), Effect.andThen(h.tick)),
		{ discard: true },
	);

describe('monitoring', () => {
	it.effect('flags a run over the wall-clock cap once and lets it keep running', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxRunSeconds: 3600 });
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');

			yield* Effect.forEach(Array.from({ length: 15 }), () => h.t3.addActivity(run.threadId).pipe(Effect.andThen(h.tick), Effect.andThen(TestClock.adjust('5 minutes'))), { discard: true });

			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(markers(h, 'TEST-10'), ['overCap:0']);
			assert.match(h.notices('TEST-10')[0].text, /^⏰ \*\*TEST-10 is over the time cap\*\*: 60 min, cap 60 min\. It keeps running\./);
			assert.deepStrictEqual(yield* statuses(h), ['running']);
		}),
	);

	it.effect('does not nudge a run whose only activity is a long-running subagent', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');

			const subagent = yield* h.t3.addSubagent(run.threadId, 'Slice 2 of TEST-10', 'running');

			yield* minuteTicks(h, 30, h.t3.addActivity(subagent));

			assert.deepStrictEqual(yield* nudges(h), []);
			assert.deepStrictEqual(yield* statuses(h), ['running']);
			assert.deepStrictEqual(markers(h, 'TEST-10'), []);
		}),
	);

	it.effect('counts a timeline item that keeps changing as progress', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');
			yield* h.t3.addActivity(run.threadId);
			yield* minuteTicks(h, 25, h.t3.updateLastItem(run.threadId));

			assert.deepStrictEqual(yield* nudges(h), []);
		}),
	);

	it.effect('nudges a run idle everywhere once after staleAfterSeconds, then flags it stale once and tells Pushover once after nudgeGraceSeconds, until it moves again', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');
			yield* h.t3.addActivity(run.threadId);
			yield* h.tick;
			yield* TestClock.adjust('599 seconds');
			yield* h.tick;
			assert.deepStrictEqual(yield* nudges(h), []);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.tick;
			assert.deepStrictEqual(yield* nudges(h), [['continue', 'restart']]);

			const [nudged] = yield* h.runs;

			assert.deepStrictEqual([nudged.status, nudged.nudgedAt, nudged.threadRunId], ['running', 600_000, `run:thread:${run.threadId}:ordinal:2`]);

			yield* TestClock.adjust('599 seconds');
			yield* h.tick;
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* minuteTicks(h, 5);

			assert.deepStrictEqual(yield* nudges(h), [['continue', 'restart']]);
			assert.deepStrictEqual(yield* statuses(h), ['stale']);
			assert.deepStrictEqual(markers(h, 'TEST-10'), ['stale:0-600000']);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.match(h.notices('TEST-10')[0].text, /^🔴 \*\*TEST-10 looks stuck\*\*: its T3 thread shows no progress for 20 min, even after a nudge, and no result file\.\n- T3 thread: `TEST-10 Plugin settings sync` \(thread-\d+\)\n/);
			assert.deepStrictEqual(h.pushover.sent(), [
				{
					title: 'TEST-10 looks stuck',
					message: 'No progress in T3 thread "TEST-10 Plugin settings sync" for 20 min, even after a nudge. The epic is flagged.',
					url: 'https://linear.app/marioparaschiv/issue/TEST-10/plugin-settings-sync',
					priority: 'normal',
				},
			]);

			yield* h.t3.addActivity(run.threadId);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map(({ status, nudgedAt }) => [status, nudgedAt]),
				[['running', null]],
			);
		}),
	);

	it.effect('tells Pushover once that a run waits on a question, and does not nudge it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');
			yield* h.t3.setPendingRequests(run.threadId, 1);
			yield* h.tick;
			yield* minuteTicks(h, 40);

			assert.deepStrictEqual(yield* nudges(h), []);
			assert.deepStrictEqual(yield* statuses(h), ['running']);
			assert.deepStrictEqual(markers(h, 'TEST-10'), []);
			assert.deepStrictEqual(h.pushover.sent(), [
				{ title: 'TEST-10 needs input', message: 'A question or approval waits in T3 thread "TEST-10 Plugin settings sync".', url: 'https://linear.app/marioparaschiv/issue/TEST-10/plugin-settings-sync', priority: 'normal' },
			]);
		}),
	);

	it.effect('does not nudge a run whose thread stopped while its background subagent keeps calling tools, and nudges, flags and tells Pushover once the calls stop', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const sessionId = '6f1c2e9a-4b7d-4c3e-8a5f-0d2b9e1c7a43';
			// What Claude Code sends before a background subagent's Bash call in the run's worktree.
			const subagentToolCall = h
				.hook(
					'claude',
					JSON.stringify({
						session_id: sessionId,
						transcript_path: `/home/dev/.claude/projects/${run.worktreePath.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`,
						cwd: run.worktreePath,
						permission_mode: 'bypassPermissions',
						hook_event_name: 'PreToolUse',
						tool_name: 'Bash',
						tool_input: { command: 'npm test', description: 'Run the tests' },
						tool_use_id: 'toolu_01HkqZ3vYb7mJ8xWn2pQ4rT5',
						agent_id: 'a4f29c81d03e5b7a6',
						agent_type: 'general-purpose',
					}),
				)
				.pipe(Effect.tap((outcome) => Effect.sync(() => assert.deepStrictEqual(outcome, { code: 0, stdout: '', stderr: '' }))));

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* subagentToolCall;
			yield* minuteTicks(h, 30, Clock.currentTimeMillis.pipe(Effect.flatMap((now) => (now % 300_000 === 0 ? subagentToolCall : Effect.void))));

			assert.deepStrictEqual(yield* nudges(h), []);
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			// A restart forgets the calls it saw, and gives the run a fresh stall period instead of a nudge.
			yield* minuteTicks(h, 3);
			yield* h.restart;
			yield* minuteTicks(h, 9);
			assert.deepStrictEqual(yield* nudges(h), []);

			yield* minuteTicks(h, 1);
			assert.deepStrictEqual(yield* nudges(h), [['continue', 'restart']]);

			yield* minuteTicks(h, 10);
			assert.deepStrictEqual(yield* statuses(h), ['stale']);
			assert.deepStrictEqual(markers(h, 'TEST-10'), ['stale:0-2580000']);
			assert.deepStrictEqual(
				h.pushover.sent().map(({ title }) => title),
				['TEST-10 looks stuck'],
			);
		}),
	);
});
