import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { Journal, type Run } from './journal.ts';
import { Reconciler } from './reconciler.ts';
import { T3 } from './t3.ts';
import { FakeT3 } from './t3-fake.ts';
import { watchThreads } from './thread-waits.ts';

const runOf = (identifier: string, threadId: string, runId: string | null, status: Run['status']): Run => ({
	epicId: `issue-${identifier.toLowerCase()}`,
	identifier,
	teamId: 'team-test',
	status,
	job: { _tag: 'orchestrate' },
	repo: '/home/dev/sapphire-agent',
	branch: `mario/${identifier.toLowerCase()}-settings-sync`,
	worktreePath: `/home/dev/.t3/worktrees/sapphire-agent/mario-${identifier.toLowerCase()}-settings-sync`,
	session: null,
	replyTo: null,
	claimedAt: 0,
	startedAt: 1_000,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	result: null,
	handoff: null,
	threadId,
	threadRunId: runId,
	threadSettledAt: null,
});

describe('watchThreads', () => {
	it.effect("wakes the reconciler once a run's thread finished or was interrupted, not when a wait only timed out, and waits again after a restart", () =>
		Effect.gen(function* () {
			const services = yield* Layer.build(Layer.mergeAll(FakeT3.layer(), Journal.layer(':memory:')));
			const t3 = Context.get(services, T3);
			const fake = Context.get(services, FakeT3);
			const journal = Context.get(services, Journal);
			const wakes = yield* Queue.unbounded<void>();
			const reconciler = Layer.succeed(Reconciler, { wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid), run: Effect.never });
			const project = yield* fake.addProject('/home/dev/sapphire-agent');
			const launch = (title: string) => t3.launchThread({ projectId: project.id, title, message: '/orchestrate Linear epic TEST-10 autonomously', runtimeMode: 'full-access' }).pipe(Effect.orDie);
			const [first, second, ended] = yield* Effect.all([launch('TEST-10 Plugin settings sync'), launch('TEST-11 Fix the file leak'), launch('TEST-12 Rename the config')]);

			yield* journal.putRun(runOf('TEST-10', first.threadId, first.runId, 'running'));
			yield* journal.putRun(runOf('TEST-11', second.threadId, second.runId, 'running'));
			yield* journal.putRun(runOf('TEST-12', ended.threadId, ended.runId, 'ended'));

			const start = Effect.forkChild(watchThreads.pipe(Effect.provide(Layer.merge(Layer.succeedContext(services), reconciler))));
			const waitCalls = fake.calls.pipe(Effect.map((calls) => calls.filter((call) => call === 't3_thread_wait').length));
			const process = yield* start;

			yield* TestClock.adjust('9 minutes');

			// Each run in flight had two waits time out and has a third open; the ended run has none.
			assert.strictEqual(yield* waitCalls, 6);
			assert.strictEqual(yield* Queue.size(wakes), 0);

			yield* fake.setRunStatus(first.threadId, 'completed');
			yield* Queue.take(wakes);
			yield* TestClock.adjust('10 seconds');

			assert.strictEqual(yield* Queue.size(wakes), 0);

			yield* Fiber.interrupt(process);

			const restarted = yield* start;

			yield* TestClock.adjust('1 second');
			// The completed run is still in flight in the journal, so the reconciler hears of it again.
			yield* Queue.take(wakes);

			yield* t3.interruptThread({ threadId: second.threadId, clientRequestId: 'stop-1' }).pipe(Effect.orDie);
			yield* Queue.take(wakes);
			yield* TestClock.adjust('10 seconds');

			assert.strictEqual(yield* Queue.size(wakes), 0);
			yield* Fiber.interrupt(restarted);
		}),
	);
});
