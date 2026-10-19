import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { onTestFinished } from 'vitest';
import type { PiHook, PiThread } from './pi-hooks.ts';
import { type Harness, makeHarness } from './test-harness.ts';

type FromAnywhere<Hook = PiHook> = Hook extends PiHook ? Omit<Hook, 'cwd'> : never;

// The payload the Pi extension sends, from anywhere: a Pi event is known by its T3 thread, not its cwd.
const piHook = (h: Harness, payload: FromAnywhere) => h.hook('pi', JSON.stringify({ ...payload, cwd: '/tmp' }));

const own = (threadId: string): PiThread => ({ threadId, parentThreadId: null, relationshipToParent: null });

const child = (threadId: string, parentThreadId: string): PiThread => ({ threadId, parentThreadId, relationshipToParent: 'subagent' });

const ok = { code: 0, stdout: '', stderr: '' };

const waiting = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('request '))));

const docPath = (identifier: string, id: string) => {
	const path = join(tmpdir(), `sapphire-agent-handoff-${identifier}-${id}.md`);

	onTestFinished(() => rmSync(path, { force: true }));

	return path;
};

describe('Pi events', () => {
	it.effect("know a run's agent by its thread: only its own session becomes the run's, never a delegated child's or another thread's", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const childThread = child('thread-child', run.threadId);

			assert.deepStrictEqual(yield* piHook(h, { event: 'session_start', reason: 'startup', sessionId: 'pi-other', thread: own('thread-other') }), ok);
			assert.deepStrictEqual(yield* piHook(h, { event: 'session_start', reason: 'startup', sessionId: 'pi-child', thread: childThread }), ok);
			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'bash', contextTokens: 20_000, sessionId: 'pi-child', thread: childThread }), ok);
			assert.deepStrictEqual(yield* piHook(h, { event: 'before_agent_start', sessionId: 'pi-unknown', thread: null }), ok);
			assert.deepStrictEqual(yield* waiting(h), []);

			assert.deepStrictEqual(yield* piHook(h, { event: 'session_start', reason: 'startup', sessionId: 'pi-run', thread: own(run.threadId) }), ok);
			assert.deepStrictEqual(yield* waiting(h), ['request 1: session TEST-10: pi-run']);
			yield* h.tick;
			assert.deepStrictEqual(
				(yield* h.runs).map(({ session }) => session),
				[{ id: 'pi-run', name: 'test-10' }],
			);

			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'bash', contextTokens: 20_000, sessionId: 'pi-child', thread: childThread }), ok);
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);

	it.effect("hands a Pi run off at the context it reported, pointing its agent at the handoff skill's file", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const thread = own(run.threadId);
			const path = docPath('TEST-10', 'pi-run');

			yield* h.t3.setRunStatus(run.threadId, 'running');
			yield* piHook(h, { event: 'session_start', reason: 'startup', sessionId: 'pi-run', thread });
			yield* h.tick;

			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'bash', contextTokens: 249_999, sessionId: 'pi-run', thread }), ok);
			assert.deepStrictEqual(yield* piHook(h, { event: 'agent_end', contextTokens: null, sessionId: 'pi-run', thread }), ok);
			assert.deepStrictEqual(yield* waiting(h), []);

			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'bash', contextTokens: 251_000, sessionId: 'pi-run', thread }), ok);
			assert.deepStrictEqual(yield* waiting(h), ['request 2: handoff TEST-10: pi-run']);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.t3.sends).map(({ threadId, message }) => [threadId, message]),
				[
					[
						run.threadId,
						`Follow ${join(h.dir, 'claude', 'skills', 'handoff', 'SKILL.md')} with these arguments: Write the document to ${path}. The next session continues this run where you stopped.`,
					],
				],
			);
		}),
	);

	it.effect("tells a run's delegated child at the threshold to hand off, as text the extension adds to its tool's result", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const thread = child('thread-child', run.threadId);
			const path = docPath('TEST-10', 'thread-child');

			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'edit', contextTokens: 249_999, sessionId: 'pi-child', thread }), ok);
			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'edit', contextTokens: 250_000, sessionId: 'pi-child', thread }), {
				code: 0,
				stdout: `Your context is full. Stop your current work now. Write a handoff document to ${path} by following ${join(h.dir, 'claude', 'skills', 'handoff', 'SKILL.md')}, then end your turn with exactly this line: HANDOFF ${path}\n`,
				stderr: '',
			});
			assert.deepStrictEqual(yield* piHook(h, { event: 'tool_result', toolName: 'edit', contextTokens: 260_000, sessionId: 'pi-child', thread }), ok);
			assert.deepStrictEqual(yield* waiting(h), []);
		}),
	);
});
