import { Cause, Context, Effect, Layer } from 'effect';

// What one rule does to one epic this tick. `identifier` (e.g. HL-9) is added to every log line as `epic`.
export type EpicWork = {
	readonly identifier: string;
	readonly apply: Effect.Effect<void, unknown>;
};

// One concern of the reconciler (dispatch, monitoring, results, cleanup, follow-ups), each in its own module that
// exports an Effect building its Rule from the services it needs. Every tick the planner runs `plan`, which observes
// whatever the rule needs and returns the work per epic. The planner then runs each epic's work in its own fiber and
// logs any failure, so one bad epic never blocks the others.
export type Rule = {
	readonly name: string;
	// Pausing stops new runs only. Rules that start runs (dispatch, follow-ups) set this and are skipped while the
	// pause file exists. Rules that watch runs in flight (monitoring, results, cleanup) leave it false.
	readonly pausable: boolean;
	readonly plan: Effect.Effect<ReadonlyArray<EpicWork>, unknown>;
};

// Interruption (shutdown) must still stop the tick, so only failures and defects are logged and dropped.
const logFailure = (message: string) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(message, cause)));

const runRule = (rule: Rule) =>
	rule.plan.pipe(
		Effect.flatMap((work) =>
			Effect.forEach(work, ({ identifier, apply }) => apply.pipe(logFailure('failed'), Effect.annotateLogs({ epic: identifier })), {
				concurrency: 'unbounded',
				discard: true,
			}),
		),
		logFailure('planning failed'),
		Effect.annotateLogs({ rule: rule.name }),
	);

export class Planner extends Context.Service<
	Planner,
	{
		// Runs the rules one after another, in the order given, so two rules never act on the same epic at once.
		readonly tick: (options: { readonly paused: boolean }) => Effect.Effect<void>;
	}
>()('herdr-linear/Planner') {
	// Build with every rule module, in order: `Planner.layer(Effect.all([dispatchRule, monitoringRule, ...]))`.
	static readonly layer = <E, R>(makeRules: Effect.Effect<ReadonlyArray<Rule>, E, R>) =>
		Layer.effect(
			Planner,
			Effect.map(makeRules, (rules) =>
				Planner.of({
					tick: ({ paused }) =>
						Effect.forEach(
							rules.filter((rule) => !(paused && rule.pausable)),
							runRule,
							{ discard: true },
						),
				}),
			),
		);
}
