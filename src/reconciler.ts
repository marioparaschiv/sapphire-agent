import { Context, Duration, Effect, Layer, Queue, Ref } from 'effect';
import { AppConfig } from './config.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';

// `scripts/ctl.sh` writes this file in the state directory after recording a request, so the service ticks at once.
export const wakeFileName = 'wake';

export class Reconciler extends Context.Service<
	Reconciler,
	{
		// Asks for a tick now, or right after the current one, without waiting for the poll interval.
		readonly wake: Effect.Effect<void>;
		// Ticks at once, then every pollSeconds and on every wake, until interrupted.
		readonly run: Effect.Effect<never>;
	}
>()('sapphire-agent/Reconciler') {
	static readonly layer = Layer.effect(
		Reconciler,
		Effect.gen(function* () {
			const { pollSeconds } = yield* AppConfig;
			const pause = yield* Pause;
			const planner = yield* Planner;
			// Holds at most one pending tick, so wakes and polls that arrive during a tick collapse into one more tick.
			const pending = yield* Queue.dropping<void>(1);
			const wasPaused = yield* Ref.make(false);

			const isPaused = pause.isPaused.pipe(
				Effect.tap((paused) =>
					Ref.getAndSet(wasPaused, paused).pipe(
						Effect.flatMap((was) => (was === paused ? Effect.void : Effect.log(paused ? 'dispatching paused' : 'dispatching resumed'))),
					),
				),
				// Not knowing whether we are paused must not start new runs.
				Effect.catch((error) => Effect.logError('cannot read the pause file; starting no new runs this tick', error).pipe(Effect.as(true))),
			);

			const request = Queue.offer(pending, undefined).pipe(Effect.asVoid);
			const tick = isPaused.pipe(Effect.flatMap((paused) => planner.tick({ paused })));

			const run = Effect.gen(function* () {
				yield* Effect.forkScoped(Effect.forever(Effect.sleep(Duration.seconds(pollSeconds)).pipe(Effect.andThen(request))));

				return yield* Effect.forever(tick.pipe(Effect.andThen(Queue.take(pending))));
			}).pipe(Effect.scoped);

			return Reconciler.of({ wake: request, run });
		}),
	);
}
