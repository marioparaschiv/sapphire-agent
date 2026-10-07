import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { makeOutage } from './outages.ts';
import { FakePushover } from './pushover-fake.ts';

const notice = ({ minutes }: { readonly minutes: number }) => ({ title: 'sapphire-agent cannot observe', message: `failing for ${minutes} min`, priority: 'high' as const });

describe('makeOutage', () => {
	it.effect('tells Pushover once per streak that lasted afterSeconds, and again for the next streak', () =>
		Effect.gen(function* () {
			const pushover = yield* FakePushover;
			const outage = yield* makeOutage(600, notice);

			yield* outage.failed('Linear answered HTTP 503');
			yield* TestClock.adjust('10 minutes');
			yield* outage.failed('Linear answered HTTP 503');
			yield* TestClock.adjust('1 day');
			yield* outage.failed('Linear answered HTTP 503');
			yield* outage.recovered;
			yield* outage.failed('Linear answered HTTP 503');
			yield* TestClock.adjust('10 minutes');
			yield* outage.failed('Linear answered HTTP 503');

			assert.deepStrictEqual(
				pushover.sent().map(({ message }) => message),
				['failing for 10 min', 'failing for 10 min'],
			);
		}).pipe(Effect.provide(FakePushover.layer)),
	);

	it.effect('with renoticeAfterSeconds, tells Pushover again only once that long has passed since the last notice, across streaks', () =>
		Effect.gen(function* () {
			const pushover = yield* FakePushover;
			const outage = yield* makeOutage(0, notice, { renoticeAfterSeconds: 86_400 });

			yield* outage.failed('T3 answered HTTP 401');
			yield* TestClock.adjust('1 hour');
			yield* outage.failed('T3 answered HTTP 401');
			yield* outage.recovered;
			yield* TestClock.adjust('1 hour');
			yield* outage.failed('T3 answered HTTP 401');
			yield* TestClock.adjust('21 hours');
			yield* outage.failed('T3 answered HTTP 401');
			assert.lengthOf(pushover.sent(), 1);

			yield* TestClock.adjust('1 hour');
			yield* outage.failed('T3 answered HTTP 401');
			assert.deepStrictEqual(
				pushover.sent().map(({ message }) => message),
				['failing for 0 min', 'failing for 1320 min'],
			);
		}).pipe(Effect.provide(FakePushover.layer)),
	);
});
