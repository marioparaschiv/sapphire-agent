import { homedir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { type PiHook, type PiThread, piAdapter, piToolCall } from './pi-hooks.ts';

const runThread: PiThread = { threadId: 'thread-run', parentThreadId: null, relationshipToParent: null };

const childThread: PiThread = { threadId: 'thread-child', parentThreadId: 'thread-run', relationshipToParent: 'subagent' };

const decode = (payload: PiHook) => piAdapter.decode(JSON.stringify(payload)).pipe(Effect.map(Option.getOrUndefined));

const common = { sessionId: 'pi-session', cwd: '/worktrees/repo/branch' };

describe('piAdapter', () => {
	it.effect("maps the run's own Pi session's events, its thread naming the run", () =>
		Effect.gen(function* () {
			const own = { ...common, threadId: 'thread-run' };
			const thread = runThread;

			for (const [reason, source] of [
				['startup', 'startup'],
				['reload', 'resume'],
				['new', 'clear'],
				['resume', 'resume'],
				['fork', 'fork'],
			] as const) {
				assert.deepStrictEqual(yield* decode({ event: 'session_start', reason, ...common, thread }), { _tag: 'SessionStarted', ...own, source });
			}
			assert.deepStrictEqual(yield* decode({ event: 'before_agent_start', ...common, thread }), { _tag: 'TurnStarted', ...own });
			assert.deepStrictEqual(yield* decode({ event: 'tool_call', toolName: 'bash', ...common, thread }), { _tag: 'Acted', ...own, agentId: null });
			assert.deepStrictEqual(yield* decode({ event: 'tool_result', toolName: 'bash', contextTokens: 41_000, ...common, thread }), {
				_tag: 'ToolUsed',
				...own,
				agentId: null,
				contextTokens: 41_000,
			});
			assert.deepStrictEqual(yield* decode({ event: 'agent_end', contextTokens: null, ...common, thread }), { _tag: 'TurnEnded', ...own, contextTokens: null });
			assert.deepStrictEqual(yield* decode({ event: 'agent_settled', ...common, thread }), { _tag: 'Notified', ...own });
			assert.deepStrictEqual(yield* decode({ event: 'session_shutdown', ...common, thread }), { _tag: 'SessionEnded', ...own });
		}),
	);

	it.effect("files a delegated child's events under its parent's thread, with the child's thread as its agent id", () =>
		Effect.gen(function* () {
			const subagent = { ...common, threadId: 'thread-run', agentId: 'thread-child' };
			const thread = childThread;

			assert.deepStrictEqual(yield* decode({ event: 'tool_result', toolName: 'edit', contextTokens: 260_000, ...common, thread }), {
				_tag: 'ToolUsed',
				...subagent,
				contextTokens: 260_000,
			});

			for (const payload of [
				{ event: 'session_start', reason: 'startup', ...common, thread },
				{ event: 'before_agent_start', ...common, thread },
				{ event: 'agent_end', contextTokens: 260_000, ...common, thread },
				{ event: 'session_shutdown', ...common, thread },
			] satisfies ReadonlyArray<PiHook>) {
				assert.deepStrictEqual(yield* decode(payload), { _tag: 'Acted', ...subagent }, payload.event);
			}
		}),
	);

	it.effect('treats a fork as a thread of its own, and drops events of a session that knows no thread', () =>
		Effect.gen(function* () {
			const fork: PiThread = { threadId: 'thread-fork', parentThreadId: 'thread-run', relationshipToParent: 'fork' };

			assert.deepStrictEqual(yield* decode({ event: 'before_agent_start', ...common, thread: fork }), { _tag: 'TurnStarted', ...common, threadId: 'thread-fork' });
			assert.isUndefined(yield* decode({ event: 'before_agent_start', ...common, thread: null }));
		}),
	);
});

describe('piToolCall', () => {
	it("sees Pi's tools as the guards' shell, file writes and read tools", () => {
		assert.deepStrictEqual(piToolCall('bash', { command: 'git push', timeout: 60 }), { _tag: 'Shell', name: 'bash', command: 'git push' });
		assert.deepStrictEqual(piToolCall('write', { path: 'src/index.ts', content: '' }), { _tag: 'FileWrite', name: 'write', path: 'src/index.ts' });
		assert.deepStrictEqual(piToolCall('edit', { path: '@~/.env', edits: [] }), { _tag: 'FileWrite', name: 'edit', path: join(homedir(), '.env') });

		for (const name of ['read', 'grep', 'find', 'ls']) {
			assert.deepStrictEqual(piToolCall(name, { path: '.' }), { _tag: 'Read', name });
		}

		for (const name of ['codemode', 'powershell', 't3_thread_send']) {
			assert.deepStrictEqual(piToolCall(name, {}), { _tag: 'Other', name });
		}
	});
});
