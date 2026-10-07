import { Duration, Effect, FiberMap, Schedule } from 'effect';
import { Journal } from './journal.ts';
import { isInFlight } from './observation.ts';
import { Reconciler } from './reconciler.ts';
import { T3 } from './t3.ts';

// Node's fetch gives up on a response whose headers take over 300 s, so each wait returns before that.
const threadWaitTimeout = Duration.minutes(4);

// How often the journal is read for runs that started or ended in T3.
const threadWaitSyncInterval = Duration.seconds(5);

// After a failed wait (T3 down, the token refused), the next try.
const retryAfterFailure = Duration.seconds(30);

// Keeps one t3_thread_wait open for the newest run of each T3 run's thread in flight, and on each command's thread, and
// wakes the reconciler once it returns, so a run that finished, failed or was interrupted is acted on within seconds.
// A wait that only timed out is opened again. Runs are read from the journal, so after a restart the waits of the runs
// in flight are opened again.
export const watchThreads = Effect.gen(function* () {
	const journal = yield* Journal;
	const t3 = yield* T3;
	const reconciler = yield* Reconciler;
	const waits = yield* FiberMap.make<string>();

	// Once the run ended the fiber stays, so the next sync does not wait on it again; it goes once the run is no longer
	// in flight.
	const waitFor = (threadId: string, runId: string | null) =>
		t3.waitThread({ threadId, ...(runId === null ? {} : { runId }), timeoutMs: Duration.toMillis(threadWaitTimeout) }).pipe(
			Effect.repeat({ until: ({ timedOut }) => !timedOut }),
			Effect.asVoid,
			Effect.catchTag('T3ToolFailure', (error) => (error.code === 'thread_not_found' || error.code === 'run_not_found' ? Effect.void : Effect.fail(error))),
			Effect.tapError((error) => Effect.logWarning(`waiting on T3 thread ${threadId} failed; trying again in ${Duration.format(retryAfterFailure)}`, error)),
			Effect.retry(Schedule.spaced(retryAfterFailure)),
			Effect.andThen(Effect.log(`T3 thread ${threadId} stopped`)),
			Effect.andThen(reconciler.wake),
			Effect.andThen(Effect.never),
		);

	const sync = Effect.gen(function* () {
		const commands = (yield* journal.listCommands).flatMap((command) =>
			command.threadId !== null && (command.status === 'claimed' || command.status === 'running') ? [[`${command.threadId} null`, { threadId: command.threadId, runId: null }] as const] : [],
		);
		const watched = new Map<string, { readonly threadId: string; readonly runId: string | null }>([
			...(yield* journal.listRuns).flatMap((run) => (run.threadId !== null && isInFlight(run) ? [[`${run.threadId} ${run.threadRunId}`, { threadId: run.threadId, runId: run.threadRunId }] as const] : [])),
			...commands,
		]);

		for (const key of [...waits].map(([waiting]) => waiting)) {
			if (!watched.has(key)) {
				yield* FiberMap.remove(waits, key);
			}
		}

		for (const [key, { threadId, runId }] of watched) {
			yield* FiberMap.run(waits, key, waitFor(threadId, runId), { onlyIfMissing: true });
		}
	});

	return yield* sync.pipe(
		Effect.catch((error) => Effect.logWarning('cannot read the runs to wait on their T3 threads', error)),
		Effect.andThen(Effect.sleep(threadWaitSyncInterval)),
		Effect.forever,
	);
}).pipe(Effect.scoped);
