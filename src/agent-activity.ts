import { Clock, Context, Effect, Layer, Option, Ref } from 'effect';

// When each T3 run's agent, or one of its subagents, last sent a hook event, by epic id. T3 does not move a subagent
// thread while it works in the background, so monitoring counts these as progress too. In memory only: a hook event
// comes with every tool call, too often to write each one to the journal. After a restart, `startedAt` stands in for
// the events the process never saw, so no run is nudged before staleAfterSeconds have passed.
export class AgentActivity extends Context.Service<
	AgentActivity,
	{
		readonly record: (epicId: string) => Effect.Effect<void>;
		// None until an event of the run arrived in this process.
		readonly lastAt: (epicId: string) => Effect.Effect<Option.Option<number>>;
		readonly startedAt: number;
	}
>()('sapphire-agent/AgentActivity') {
	static readonly layer = Layer.effect(
		AgentActivity,
		Effect.gen(function* () {
			const startedAt = yield* Clock.currentTimeMillis;
			const seen = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

			return AgentActivity.of({
				record: (epicId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.update(seen, (all) => new Map([...all, [epicId, now]])))),
				lastAt: (epicId) => Ref.get(seen).pipe(Effect.map((all) => Option.fromUndefinedOr(all.get(epicId)))),
				startedAt,
			});
		}),
	);
}
