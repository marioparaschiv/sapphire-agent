import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { type Harness, makeHarness } from './test-harness.ts';

// A hook payload as Claude Code writes it on stdin.
const claudeHook = (event: string, sessionId: string, fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		session_id: sessionId,
		transcript_path: `/home/dev/.claude/projects/-tmp/${sessionId}.jsonl`,
		cwd: '/tmp',
		permission_mode: 'bypassPermissions',
		hook_event_name: event,
		...fields,
	});

const resumedSession = '5d0c8a52-6f1e-4b6a-9d3e-2f7c1b9e4a10';

const waiting = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('request '))));

describe('agent events', () => {
	it.effect("a run's events are known by its worktree: its agent's session is recorded once, from anywhere inside it, and other directories record nothing", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const inWorktree = { cwd: run.worktreePath };

			for (const cwd of [h.repo, `${run.worktreePath}-other`, '/tmp']) {
				assert.deepStrictEqual(yield* h.hook('claude', claudeHook('UserPromptSubmit', resumedSession, { cwd, prompt: 'continue' })), { code: 0, stdout: '', stderr: '' });
			}

			assert.deepStrictEqual(yield* waiting(h), []);

			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('UserPromptSubmit', resumedSession, { ...inWorktree, prompt: '/orchestrate Linear epic TEST-10 autonomously' })), { code: 0, stdout: '', stderr: '' });
			assert.deepStrictEqual(
				yield* h.hook('claude', claudeHook('PostToolUse', resumedSession, { cwd: `${run.worktreePath}/src`, tool_name: 'Read', tool_input: { file_path: 'index.ts' } })),
				{ code: 0, stdout: '', stderr: '' },
			);
			assert.deepStrictEqual(yield* waiting(h), [`request 1: session TEST-10: ${resumedSession}`]);

			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map(({ session }) => session),
				[{ id: resumedSession, name: 'test-10' }],
			);
			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('SessionEnd', resumedSession, { ...inWorktree, reason: 'other' })), { code: 0, stdout: '', stderr: '' });
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect('an event that does not match its agent, or from an unknown agent, fails the hook with the reason', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			const unknownSource = yield* h.hook('claude', claudeHook('SessionStart', resumedSession, { cwd: run.worktreePath, source: 'teleport' }));
			const unknownAgent = yield* h.hook('codex', claudeHook('Stop', resumedSession, { cwd: run.worktreePath }));

			assert.deepStrictEqual(unknownSource, {
				code: 1,
				stdout: '',
				stderr: 'sapphire-agent refused the claude event: Expected "startup" | "resume" | "clear" | "compact" | "fork"   at ["source"]\n',
			});
			assert.deepStrictEqual(unknownAgent, { code: 1, stdout: '', stderr: 'sapphire-agent refused the codex event: Expected "claude" | "pi"   at ["agent"]\n' });
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect('the hook succeeds without doing anything while the service is down', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.stop;

			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('SessionStart', resumedSession, { cwd: run.worktreePath, source: 'resume' })), { code: 0, stdout: '', stderr: '' });
		}),
	);
});
