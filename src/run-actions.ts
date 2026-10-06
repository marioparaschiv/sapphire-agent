import { Effect, Option } from 'effect';
import type { CallError } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Herdr } from './herdr.ts';
import { Journal, type JournalError, type Run } from './journal.ts';
import { Linear } from './linear.ts';
import type { Notice } from './markers.ts';
import { type Observation, stuckLabelOf, tabOf } from './observation.ts';

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

export const makeTabActions = Effect.gen(function* () {
	const herdr = yield* Herdr;
	const journal = yield* Journal;

	// Closes the run's tab if the observation still shows it. Matched by tab and pane id, so a tab the user renamed
	// closes too, while a tab that only reuses the id does not.
	const closeRunTab = (observation: Observation, run: Run): Effect.Effect<void, CallError> =>
		Option.match(tabOf(observation, run), {
			onNone: () => Effect.void,
			onSome: (tab) => herdr.closeTab(tab.tabId).pipe(Effect.andThen((closed) => (closed ? Effect.log(`closed tab ${tab.tabId}`) : Effect.void))),
		});

	// The run is over: its tab is closed first, so a crash in between leaves a run that is ended again next tick.
	const endRun = (observation: Observation, run: Run, reason: string): Effect.Effect<void, CallError | JournalError> =>
		closeRunTab(observation, run).pipe(
			Effect.andThen(journal.putRun({ ...run, status: 'ended' })),
			Effect.andThen(Effect.log(`${reason}; ended the run`)),
		);

	return { closeRunTab, endRun };
});

// Esc, then the prompt `continue`, for an agent whose pane stopped changing. The stale handling follows after its grace
// period whether or not the nudge got through, so a failure is only logged.
export const makeNudge = Effect.gen(function* () {
	const herdr = yield* Herdr;

	return (paneId: string): Effect.Effect<void> =>
		herdr.sendKeys(paneId, ['esc']).pipe(
			Effect.andThen(herdr.prompt(paneId, 'continue')),
			Effect.andThen(Effect.log(`nudged ${paneId}`)),
			Effect.catch((error) => Effect.logWarning(`nudging ${paneId} failed: ${error.message}`)),
		);
});
