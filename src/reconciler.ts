import { Context, Duration, Effect, Layer, Queue, Ref } from 'effect';
import { AppConfig } from './config.ts';
import { makeOutage } from './outages.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { T3 } from './t3.ts';

// The CLI writes this file in the state directory after recording a request or a pause, so the service ticks at once.
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
			const { pollSeconds, t3: t3Settings } = yield* AppConfig;
			const pause = yield* Pause;
			const planner = yield* Planner;
			const t3 = yield* T3;
			// Holds at most one pending tick, so wakes and polls that arrive during a tick collapse into one more tick.
			const pending = yield* Queue.dropping<void>(1);
			const wasPaused = yield* Ref.make(false);
			const pauseUnreadable = yield* makeOutage(0, ({ error }) => ({
				title: 'sapphire-agent cannot read its pause file',
				message: `No new run starts until it can read ${pause.path}: ${error}`,
				priority: 'high',
			}));

			const isPaused = pause.isPaused.pipe(
				Effect.tap((paused) =>
					Ref.getAndSet(wasPaused, paused).pipe(
						Effect.flatMap((was) => (was === paused ? Effect.void : Effect.log(paused ? 'dispatching paused' : 'dispatching resumed'))),
					),
				),
				Effect.tap(() => pauseUnreadable.recovered),
				// Not knowing whether we are paused must not start new runs.
				Effect.catch((error) =>
					Effect.logError('cannot read the pause file; starting no new runs this tick', error).pipe(Effect.andThen(pauseUnreadable.failed(error.message)), Effect.as(true)),
				),
			);

			const tokenRejected = yield* makeOutage(
				0,
				({ error }) => ({
					title: 'T3 rejects the sapphire-agent token',
					message: `No new run starts until T3 accepts the token in ${t3Settings.tokenFile}. Run scripts/mint-t3-token.sh again to write a new one. T3 said: ${error}`,
					priority: 'high',
				}),
				{ renoticeAfterSeconds: 24 * 60 * 60 },
			);

			// Runs started while T3 rejects the token would only fail. T3 being unreachable is left to the calls that need it.
			const isTokenRejected = t3.ping.pipe(
				Effect.andThen(tokenRejected.recovered),
				Effect.as(false),
				Effect.catchTag('T3Unauthorized', (error) =>
					Effect.logError('T3 rejects the token; starting no new runs this tick', error).pipe(Effect.andThen(tokenRejected.failed(error.message)), Effect.as(true)),
				),
				Effect.catch((error) => Effect.logWarning('cannot check the T3 token', error).pipe(Effect.as(false))),
			);

			const request = Queue.offer(pending, undefined).pipe(Effect.asVoid);
			const tick = Effect.all([isPaused, isTokenRejected], { concurrency: 'unbounded' }).pipe(Effect.flatMap(([paused, rejected]) => planner.tick({ paused: paused || rejected })));

			const run = Effect.gen(function* () {
				yield* Effect.forkScoped(Effect.forever(Effect.sleep(Duration.seconds(pollSeconds)).pipe(Effect.andThen(request))));

				return yield* Effect.forever(tick.pipe(Effect.andThen(Queue.take(pending))));
			}).pipe(Effect.scoped);

			return Reconciler.of({ wake: request, run });
		}),
	);
}
