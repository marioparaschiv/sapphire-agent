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
	it.effect("a session resumed in a run's pane becomes the run's session, under the run's name", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('SessionStart', resumedSession, { source: 'resume' }), run.paneId), { code: 0, stdout: '', stderr: '' });
			assert.deepStrictEqual(yield* waiting(h), [`request 1: session TEST-10: ${resumedSession}`]);

			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map(({ session }) => session),
				[{ id: resumedSession, name: 'test-10' }],
			);
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect("the run's own session, its turns, its subagents and other panes record nothing", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const own = run.session.id;

			for (const [payload, paneId] of [
				[claudeHook('SessionStart', own, { source: 'startup' }), run.paneId],
				[claudeHook('UserPromptSubmit', own, { prompt: 'continue' }), run.paneId],
				[claudeHook('Notification', own, { message: 'Claude needs your permission to use Bash' }), run.paneId],
				[claudeHook('Stop', own, { stop_hook_active: false }), run.paneId],
				[claudeHook('SessionEnd', own, { reason: 'prompt_input_exit' }), run.paneId],
				[claudeHook('SessionStart', resumedSession, { source: 'startup', agent_id: 'a1b2c3' }), run.paneId],
				[claudeHook('SessionStart', resumedSession, { source: 'resume' }), 'w9:p9'],
				[claudeHook('SessionStart', resumedSession, { source: 'resume' }), null],
			] as const) {
				assert.deepStrictEqual(yield* h.hook('claude', payload, paneId), { code: 0, stdout: '', stderr: '' });
			}

			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect("tells the manager in one line when a run's agent needs something, finished its turn or ended, and nothing of its other events, its pane's output or other panes", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({}, { answerChat: true });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const own = run.session.id;

			h.herdr.setTail(run.paneId, '⏺ Bash(npm test)\n  ⎿  12 passed');

			for (const [payload, paneId] of [
				[claudeHook('UserPromptSubmit', own, { prompt: 'continue' }), run.paneId],
				[claudeHook('PostToolUse', own, { tool_name: 'Bash', tool_input: { command: 'npm test' } }), run.paneId],
				[claudeHook('Notification', own, { message: 'Claude needs your permission\n  to use Bash' }), run.paneId],
				[claudeHook('Stop', resumedSession, { stop_hook_active: false }), 'w9:p9'],
				[claudeHook('Stop', own, { stop_hook_active: false }), run.paneId],
				[claudeHook('SessionEnd', own, { reason: 'prompt_input_exit' }), run.paneId],
			] as const) {
				yield* h.hook('claude', payload, paneId);
			}

			yield* h.manager.awaitInputs(3);

			assert.deepStrictEqual(
				h.manager.sessions.flatMap(({ inputs }) => inputs.map(({ text }) => text)),
				[
					'Agent event: TEST-10 orchestrate run: Claude needs your permission to use Bash',
					'Agent event: TEST-10 orchestrate run: finished its turn',
					'Agent event: TEST-10 orchestrate run: session ended (prompt_input_exit)',
				],
			);
		}),
	);

	it.effect('an event that does not match its agent, or from an unknown agent, fails the hook with the reason', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			const unknownSource = yield* h.hook('claude', claudeHook('SessionStart', resumedSession, { source: 'teleport' }), run.paneId);
			const unknownAgent = yield* h.hook('codex', claudeHook('Stop', resumedSession), run.paneId);

			assert.deepStrictEqual(unknownSource, {
				code: 1,
				stdout: '',
				stderr: 'sapphire-agent refused the claude event: Expected "startup" | "resume" | "clear" | "compact" | "fork"   at ["source"]\n',
			});
			assert.deepStrictEqual(unknownAgent, { code: 1, stdout: '', stderr: 'sapphire-agent refused the codex event: Expected "claude"   at ["agent"]\n' });
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect('the hook succeeds without doing anything while the service is down', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			yield* h.stop;

			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('SessionStart', resumedSession, { source: 'resume' }), run.paneId), { code: 0, stdout: '', stderr: '' });
		}),
	);
});
