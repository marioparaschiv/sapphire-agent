import { Cause, Clock, Context, Effect, Layer, Option, Ref } from 'effect';
import { Permanent, Transient } from './call-policy.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { Journal } from './journal.ts';
import { Linear } from './linear.ts';
import { type Observation, Observer } from './observation.ts';
import { makeFlag } from './run-actions.ts';

// What one rule does to one epic this tick. `identifier` (e.g. HL-9) is added to every log line as `epic`; epicId and
// teamId say where a failure is flagged.
export type EpicWork = {
	readonly epicId: string;
	readonly identifier: string;
	readonly teamId: string;
	readonly apply: Effect.Effect<void, unknown>;
};

// What one rule does this tick that is not about an epic: a command, the GitHub mentions, a request whose epic has no
// run. `task` (e.g. CMD-3) names it in every log line. There is no epic to flag, so the work handles the failures it
// can act on itself and the planner only logs the rest.
export type TaskWork = {
	readonly task: string;
	readonly apply: Effect.Effect<void, unknown>;
};

export type Work = EpicWork | TaskWork;

const isTaskWork = (work: Work): work is TaskWork => 'task' in work;

// One concern of the reconciler (dispatch, monitoring, results, cleanup, follow-ups, commands), each in its own module
// that exports an Effect building its Rule from the services it needs. Every tick the planner observes the world once
// and hands that to each rule's `plan`, which reads the journal and returns the work per epic or task, at most one
// each. The planner then runs each piece of work in its own fiber under the failure policy, so one bad epic never
// blocks the others.
export type Rule = {
	readonly name: string;
	// Pausing stops new runs only. Rules that start runs (dispatch, follow-ups) set this and are skipped while the
	// pause file exists. Rules that watch runs in flight (monitoring, results, cleanup) leave it false.
	readonly pausable: boolean;
	readonly plan: (observation: Observation) => Effect.Effect<ReadonlyArray<Work>, unknown>;
};

// Interruption (shutdown) must still stop the tick, so only failures and defects are logged and dropped.
const logFailure = (message: string) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(message, cause)));

const isTransient = (error: unknown): error is Transient => error instanceof Transient;

const isPermanent = (error: unknown): error is Permanent => error instanceof Permanent;

// Decision 5 at the epic level. Success ends the epic's transient streak. A Transient failure is retried next tick and
// flags the epic once its streak is older than flagTransientAfterSeconds. A Permanent one flags the epic once per run
// (or, without a run, once per streak). A rate limit stops the rest of the tick; the call policy already waited
// Retry-After between its attempts.
const makePolicy = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const linear = yield* Linear;
	const comments = yield* Comments;
	const flag = yield* makeFlag;

	return (observation: Observation, rateLimited: Ref.Ref<boolean>, work: EpicWork) =>
		work.apply.pipe(
			Effect.andThen(journal.clearTransient(work.epicId)),
			Effect.catchIf(isTransient, (error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning('failed; retrying next tick', error);

					if (error.retryAfter) {
						yield* Ref.set(rateLimited, true);
					}

					const streakStartedAt = yield* journal.recordTransient(work.epicId);
					const now = yield* Clock.currentTimeMillis;

					if (now - streakStartedAt >= config.flagTransientAfterSeconds * 1000) {
						yield* linear.comment(work.epicId, comments.transientFailure({ identifier: work.identifier, streakStartedAt, error: error.message, now }));
					}
				}),
			),
			Effect.catchIf(isPermanent, (error) =>
				Effect.gen(function* () {
					yield* Effect.logError('failed', error);

					const run = yield* journal.getRun(work.epicId);
					const claimedAt = Option.isSome(run) ? run.value.claimedAt : yield* journal.recordTransient(work.epicId);

					yield* flag(observation, work, comments.permanentFailure({ identifier: work.identifier, claimedAt, error: error.message }));
				}),
			),
			logFailure('failed'),
			Effect.annotateLogs({ epic: work.identifier }),
		);
});

export class Planner extends Context.Service<
	Planner,
	{
		// Observes, then runs the rules one after another, in the order given, so two rules never act on the same epic
		// at once and each sees in the journal what the rules before it did.
		readonly tick: (options: { readonly paused: boolean }) => Effect.Effect<void>;
	}
>()('herdr-linear/Planner') {
	// Build with every rule module, in order: `Planner.layer(Effect.all([cleanupRule, resultsRule, ...]))`.
	static readonly layer = <E, R>(makeRules: Effect.Effect<ReadonlyArray<Rule>, E, R>) =>
		Layer.effect(
			Planner,
			Effect.gen(function* () {
				const rules = yield* makeRules;
				const observer = yield* Observer;
				const reconcileEpic = yield* makePolicy;

				const runWork = (observation: Observation, rateLimited: Ref.Ref<boolean>) => (work: Work) =>
					isTaskWork(work) ? work.apply.pipe(logFailure('failed'), Effect.annotateLogs({ task: work.task })) : reconcileEpic(observation, rateLimited, work);

				const runRule = (observation: Observation, rateLimited: Ref.Ref<boolean>) => (rule: Rule) =>
					rule.plan(observation).pipe(
						Effect.flatMap((work) => Effect.forEach(work, runWork(observation, rateLimited), { concurrency: 'unbounded', discard: true })),
						logFailure('planning failed'),
						Effect.annotateLogs({ rule: rule.name }),
					);

				const tick = ({ paused }: { readonly paused: boolean }) =>
					Effect.gen(function* () {
						const observation = yield* observer.observe;
						const rateLimited = yield* Ref.make(false);

						for (const rule of rules.filter((candidate) => !(paused && candidate.pausable))) {
							if (yield* Ref.get(rateLimited)) {
								return yield* Effect.logWarning(`rate limited; skipping ${rule.name} and the rules after it until the next tick`);
							}

							yield* runRule(observation, rateLimited)(rule);
						}
					}).pipe(logFailure('observing failed'));

				return Planner.of({ tick });
			}),
		);
}
