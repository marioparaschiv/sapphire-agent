import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { T3, T3ToolFailure, T3Unauthorized } from './t3.ts';
import { FakeT3 } from './t3-fake.ts';

// The port as later slices drive it, against the fake: a run launched for an epic, watched, steered and settled.
const setup = Effect.gen(function* () {
	const t3 = yield* T3;
	const fake = yield* FakeT3;
	const project = yield* fake.addProject('/home/dev/unbound');
	const launched = yield* t3.launchThread({
		projectId: project.id,
		title: 'UNB-12 Settings sync',
		message: 'Implement UNB-12 and open a PR.',
		workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'mario/unb-12-settings-sync' },
		runtimeMode: 'full-access',
	});

	return { t3, fake, project, launched };
}).pipe(Effect.provide(FakeT3.layer));

describe('FakeT3', () => {
	it.effect('launches a thread whose run a wait follows until it is terminal, and lists it with its subagents unless asked not to', () =>
		Effect.gen(function* () {
			const { t3, fake, project, launched } = yield* setup;
			const subagent = yield* fake.addSubagent(launched.threadId, 'Review the settings migration', 'running');
			const wait = yield* t3.waitThread({ threadId: launched.threadId, timeoutMs: 60_000 }).pipe(Effect.forkChild);

			yield* TestClock.adjust('10 seconds');
			yield* fake.setRunStatus(launched.threadId, 'running');
			yield* TestClock.adjust('10 seconds');
			assert.isUndefined(wait.pollUnsafe());

			yield* fake.setRunStatus(launched.threadId, 'completed');

			assert.deepStrictEqual(yield* Fiber.join(wait), { threadId: launched.threadId, runId: launched.runId, status: 'completed', timedOut: false });
			assert.deepStrictEqual(
				(yield* t3.listThreads({ projectId: project.id })).map(({ title, status, parentThreadId }) => [title, status, parentThreadId]),
				[
					['Review the settings migration', 'running', launched.threadId],
					['UNB-12 Settings sync', 'completed', null],
				],
			);
			assert.deepStrictEqual(
				(yield* t3.listThreads({ projectId: project.id, includeSubagents: false })).map(({ threadId }) => threadId),
				[launched.threadId],
			);
			assert.deepStrictEqual(
				(yield* t3.listThreads({ projectId: project.id, statuses: ['running'] })).map(({ threadId }) => threadId),
				[subagent],
			);
		}),
	);

	it.effect('returns a wait after timeoutMs with timedOut set, leaving the run going', () =>
		Effect.gen(function* () {
			const { t3, launched } = yield* setup;
			const wait = yield* t3.waitThread({ threadId: launched.threadId, timeoutMs: 30_000 }).pipe(Effect.forkChild);

			yield* TestClock.adjust('30 seconds');

			assert.deepStrictEqual(yield* Fiber.join(wait), { threadId: launched.threadId, runId: launched.runId, status: 'preparing', timedOut: true });
			assert.deepStrictEqual((yield* t3.readThread({ threadId: launched.threadId })).thread.status, 'preparing');
		}),
	);

	it.effect('steers an active run, starts a new one once it ended, answers a retried send once, and interrupts', () =>
		Effect.gen(function* () {
			const { t3, fake, launched } = yield* setup;
			const steered = yield* t3.sendThread({ threadId: launched.threadId, message: 'Also cover the offline case.', clientRequestId: 'unb-12-steer' });

			yield* fake.setRunStatus(launched.threadId, 'completed');

			const followUp = { threadId: launched.threadId, message: 'Answer the review threads on the PR.', clientRequestId: 'unb-12-follow-up-1' };
			const started = yield* t3.sendThread(followUp);
			const retried = yield* t3.sendThread(followUp);
			const interrupted = yield* t3.interruptThread({ threadId: launched.threadId, clientRequestId: 'unb-12-stop' });
			const again = yield* t3.interruptThread({ threadId: launched.threadId, clientRequestId: 'unb-12-stop-again' });
			const runs = Option.map(yield* fake.thread(launched.threadId), (thread) => thread.runs.map(({ runId, status }) => [runId, status]));

			assert.deepStrictEqual([steered.delivery, steered.runId], ['steered', launched.runId]);
			assert.deepStrictEqual([started.delivery, started.status], ['started', 'starting']);
			assert.deepStrictEqual(retried, started);
			assert.deepStrictEqual(interrupted, { threadId: launched.threadId, runId: started.runId, status: 'interrupt_requested' });
			assert.deepStrictEqual(again, { threadId: launched.threadId, runId: null, status: 'no_active_run' });
			assert.deepStrictEqual(
				runs,
				Option.some([
					[launched.runId, 'completed'],
					[started.runId, 'interrupted'],
				]),
			);
		}),
	);

	it.effect('settles a thread, and fails with thread_not_found for one that is gone', () =>
		Effect.gen(function* () {
			const { t3, project, launched } = yield* setup;

			yield* t3.organizeThread({ threadId: launched.threadId, action: 'settle' });

			assert.deepStrictEqual((yield* t3.listThreads({ projectId: project.id, settled: false })).length, 0);
			assert.deepStrictEqual(
				(yield* t3.listThreads({ projectId: project.id, settled: true })).map(({ title, settled }) => [title, settled]),
				[['UNB-12 Settings sync', true]],
			);
			assert.deepStrictEqual(
				yield* t3.readThread({ threadId: 'thread-gone' }).pipe(Effect.flip),
				new T3ToolFailure({ tool: 't3_thread_read', code: 'thread_not_found', message: 'Thread thread-gone is no longer available.' }),
			);
		}),
	);

	it.effect('fails every call T3Unauthorized while the token is rejected, without retrying', () =>
		Effect.gen(function* () {
			const { t3, fake, launched } = yield* setup;

			yield* fake.rejectToken(true);

			assert.deepStrictEqual(
				yield* t3.readThread({ threadId: launched.threadId }).pipe(Effect.flip),
				new T3Unauthorized({ message: 'T3 answered HTTP 401: {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}' }),
			);
			assert.deepStrictEqual(yield* fake.calls, ['t3_thread_launch', 't3_thread_read']);

			yield* fake.rejectToken(false);
			assert.strictEqual((yield* t3.readThread({ threadId: launched.threadId })).thread.threadId, launched.threadId);
		}),
	);

	it.effect('times a hanging call out after 30 s, retries a read 3 times, then fails Transient; a launch is not retried', () =>
		Effect.gen(function* () {
			const { t3, fake, project, launched } = yield* setup;

			yield* fake.hang(true);

			const before = (yield* fake.calls).length;
			const read = yield* t3.readThread({ threadId: launched.threadId }).pipe(Effect.forkChild);
			const launch = yield* t3.launchThread({ projectId: project.id, title: 'UNB-13 Offline mode', message: 'Implement UNB-13.' }).pipe(Effect.forkChild);

			yield* TestClock.adjust('10 minutes');

			const timedOut = new Transient({ message: 'timed out after 30s' });

			assert.deepStrictEqual(yield* Fiber.await(read), Exit.fail(timedOut));
			assert.deepStrictEqual(yield* Fiber.await(launch), Exit.fail(timedOut));
			assert.deepStrictEqual(
				(yield* fake.calls).slice(before).toSorted(),
				['t3_thread_launch', 't3_thread_read', 't3_thread_read', 't3_thread_read', 't3_thread_read'],
			);
		}),
	);
});
