import { Cause, Clock, Context, Duration, Effect, Layer, Option, Queue } from 'effect';
import type { CallError } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { type Delivery, GitHubApp } from './github-app.ts';
import { Journal, type JournalError } from './journal.ts';

// GitHub keeps an App's webhook deliveries this long.
const retention = Duration.days(3);

const succeeded = ({ statusCode }: Delivery) => statusCode >= 200 && statusCode < 300;

// For each event (`guid`) whose newest attempt failed, that attempt. `deliveries` is newest first.
const toRedeliver = (deliveries: ReadonlyArray<Delivery>) => {
	const settled = new Set<string>();
	const failed: Array<Delivery> = [];

	for (const delivery of deliveries) {
		if (!settled.has(delivery.guid) && !succeeded(delivery)) {
			failed.push(delivery);
		}

		settled.add(delivery.guid);
	}

	return failed;
};

// GitHub does not redeliver a failed webhook delivery by itself, so a mention made while the service was down, or
// whose journal write failed, would be lost. This asks GitHub to redeliver each one, and the redelivery comes in
// through the webhook server like any delivery; recording a mention is idempotent, so it never runs twice.
export class MissedDeliveries extends Context.Service<
	MissedDeliveries,
	{
		// Pages the App's deliveries back to the journal's delivery mark, at most 3 days back, redelivers the events whose
		// newest attempt failed, then moves the mark to the newest delivery seen. A redelivery GitHub refuses leaves the mark
		// where it was, so the next scan looks at it again.
		readonly scan: Effect.Effect<void, CallError | JournalError>;
		// Scans at once, then every deliveryScanSeconds, until interrupted. A failed scan is logged and tried again on
		// the next one.
		readonly run: Effect.Effect<never>;
	}
>()('herdr-linear/MissedDeliveries') {
	static readonly layer = Layer.effect(
		MissedDeliveries,
		Effect.gen(function* () {
			const { deliveryScanSeconds } = yield* AppConfig;
			const app = yield* GitHubApp;
			const journal = yield* Journal;

			const scan = Effect.gen(function* () {
				const mark = yield* journal.deliveryMark;
				const oldest = (yield* Clock.currentTimeMillis) - Duration.toMillis(retention);
				const isUnseen = (delivery: Delivery) => Option.match(mark, { onNone: () => true, onSome: (at) => delivery.id > at }) && Date.parse(delivery.deliveredAt) >= oldest;

				const unseenFrom = (cursor: Option.Option<string>): Effect.Effect<ReadonlyArray<Delivery>, CallError> =>
					app.deliveries(cursor).pipe(
						Effect.flatMap(({ deliveries, next }) => {
							const seenAt = deliveries.findIndex((delivery) => !isUnseen(delivery));
							const unseen = seenAt === -1 ? deliveries : deliveries.slice(0, seenAt);

							return seenAt !== -1 || Option.isNone(next) ? Effect.succeed(unseen) : Effect.map(unseenFrom(next), (older) => [...unseen, ...older]);
						}),
					);

				const unseen = yield* unseenFrom(Option.none());
				const [, refused] = yield* Effect.partition(toRedeliver(unseen).reverse(), (delivery) =>
					app.redeliver(delivery.id).pipe(
						Effect.tap(() => Effect.log(`redelivered webhook delivery ${delivery.id} (${delivery.guid}), which failed with HTTP ${delivery.statusCode}`)),
						Effect.mapError((error) => ({ delivery, error })),
					),
				);

				if (refused.length > 0) {
					yield* Effect.forEach(refused, ({ delivery, error }) => Effect.logError(`cannot redeliver webhook delivery ${delivery.id} (${delivery.guid}); trying again next scan`, error));

					return;
				}

				if (unseen.length > 0) {
					yield* journal.setDeliveryMark(unseen[0].id);
				}
			});

			const loggedScan = scan.pipe(
				Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError('cannot scan for failed webhook deliveries; trying again next scan', cause))),
			);

			// Holds at most one pending scan, so a scan that outlasts the interval is followed by one more, not several.
			const run = Effect.gen(function* () {
				const due = yield* Queue.dropping<void>(1);

				yield* Effect.forkScoped(Effect.forever(Effect.sleep(Duration.seconds(deliveryScanSeconds)).pipe(Effect.andThen(Queue.offer(due, undefined)))));

				return yield* Effect.forever(loggedScan.pipe(Effect.andThen(Queue.take(due))));
			}).pipe(Effect.scoped);

			return MissedDeliveries.of({ scan, run });
		}),
	);
}
