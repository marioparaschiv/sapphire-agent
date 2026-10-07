import { Clock, Effect, Option, Ref } from 'effect';
import { Pushover, type PushoverMessage } from './pushover.ts';

// A failure of the whole service rather than of one epic, e.g. Linear being unreachable. Pushover hears of each streak
// of it once, as soon as it has lasted `afterSeconds`; a send that fails is tried again at the next failure. With
// `renoticeAfterSeconds`, Pushover hears of it again once that long has passed since the last notice, whether the
// streak went on or a new one began. The streak lives in memory, so a restart during one notifies again.
export const makeOutage = (
	afterSeconds: number,
	notice: (failure: { readonly error: string; readonly minutes: number }) => PushoverMessage,
	{ renoticeAfterSeconds }: { readonly renoticeAfterSeconds?: number } = {},
) =>
	Effect.gen(function* () {
		const pushover = yield* Pushover;
		const streakSince = yield* Ref.make(Option.none<number>());
		const notifiedAt = yield* Ref.make(Option.none<number>());

		const failed = (error: string) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const since = Option.getOrElse(yield* Ref.get(streakSince), () => now);

				yield* Ref.set(streakSince, Option.some(since));

				const due = Option.match(yield* Ref.get(notifiedAt), {
					onNone: () => true,
					onSome: (at) => (renoticeAfterSeconds === undefined ? at < since : now - at >= renoticeAfterSeconds * 1000),
				});

				if (!due || now - since < afterSeconds * 1000) {
					return;
				}

				yield* pushover.send(notice({ error, minutes: Math.round((now - since) / 60_000) })).pipe(
					Effect.andThen(Ref.set(notifiedAt, Option.some(now))),
					Effect.catch((sendError) => Effect.logError('cannot send the notice to Pushover; trying again at the next failure', sendError)),
				);
			});

		return { failed, recovered: Ref.set(streakSince, Option.none()) };
	});
