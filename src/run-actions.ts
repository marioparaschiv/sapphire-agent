import { Effect, Option } from 'effect';
import type { CallError } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Journal, type JournalError, type Run } from './journal.ts';
import { Linear } from './linear.ts';
import type { Notice } from './markers.ts';
import { type Observation, stuckLabelOf } from './observation.ts';
import { T3, type T3Error } from './t3.ts';

// The epic a flag goes on.
export type FlagTarget = { readonly epicId: string; readonly teamId: string };

// Flag = the stuck label plus a notice, once. The label goes on first: a crash between the two leaves no notice, so the
// next tick finishes the flag, while a notice found means the flag is complete and a label the user removed since then
// stays removed.
export const makeFlag = Effect.gen(function* () {
	const config = yield* AppConfig;
	const linear = yield* Linear;
	const journal = yield* Journal;

	return (observation: Observation, { epicId, teamId }: FlagTarget, notice: Notice): Effect.Effect<void, CallError | JournalError> =>
		Effect.gen(function* () {
			if (yield* journal.hasNotice(notice.marker)) {
				return;
			}

			const epic = Option.fromUndefinedOr(observation.epics.get(epicId));

			if (!Option.exists(epic, (found) => Option.isSome(stuckLabelOf(config, found)))) {
				yield* linear.addLabel(epicId, teamId, config.labels.stuck);
			}

			yield* journal.addNotice(notice);
		});
});

// The run is over.
export const makeEndRun = Effect.gen(function* () {
	const journal = yield* Journal;

	return (run: Run, reason: string): Effect.Effect<void, JournalError> =>
		journal.putRun({ ...run, status: 'ended' }).pipe(Effect.andThen(Effect.log(`${reason}; ended the run`)));
});

// Interrupts the newest run of a run's or command's T3 thread, if it has one. clientRequestId makes a retry land once.
// A thread that is gone or has nothing left to interrupt is fine.
export const makeInterrupt = Effect.gen(function* () {
	const t3 = yield* T3;

	return ({ threadId }: { readonly threadId: string | null }, reason: string, clientRequestId: string): Effect.Effect<void, T3Error> =>
		threadId === null
			? Effect.void
			: t3.interruptThread({ threadId, reason, clientRequestId }).pipe(
					Effect.andThen(({ status }) => Effect.log(`interrupted T3 thread ${threadId}: ${status}`)),
					Effect.catchTag('T3ToolFailure', (error) =>
						error.code === 'thread_not_found' || error.code === 'thread_not_interruptible' ? Effect.log(`T3 thread ${threadId} has nothing to interrupt: ${error.message}`) : Effect.fail(error),
					),
				);
});

// Settles the T3 thread; one that is gone has nothing left to settle.
export const makeSettle = Effect.gen(function* () {
	const t3 = yield* T3;

	return (threadId: string): Effect.Effect<void, T3Error> =>
		t3.organizeThread({ threadId, action: 'settle' }).pipe(
			Effect.andThen(Effect.log(`settled T3 thread ${threadId}`)),
			Effect.catchTag('T3ToolFailure', (error) => (error.code === 'thread_not_found' ? Effect.void : Effect.fail(error))),
		);
});

// Sends a message to the run's T3 thread, keyed so a retry lands once; the run follows the thread's newest run. T3
// refusing it is logged.
export const makeSend = Effect.gen(function* () {
	const t3 = yield* T3;
	const journal = yield* Journal;

	return (run: Run & { readonly threadId: string }, message: string, { mode, clientRequestId }: { readonly mode: 'auto' | 'restart'; readonly clientRequestId: string }) =>
		t3.sendThread({ threadId: run.threadId, message, mode, clientRequestId }).pipe(
			Effect.tap(({ runId }) => (runId === run.threadRunId ? Effect.void : journal.putRun({ ...run, threadRunId: runId }))),
			Effect.andThen(({ delivery }) => Effect.log(`sent ${clientRequestId} to T3 thread ${run.threadId} (${delivery})`)),
			Effect.catchTag('T3ToolFailure', (error) => Effect.logWarning(`sending ${clientRequestId} to T3 thread ${run.threadId} failed: ${error.message}`)),
		);
});
