import { assert, describe, it } from '@effect/vitest';
import { Duration, Effect, Exit, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy } from './call-policy.ts';

// A call that fails with the given errors in turn, then succeeds, and counts its attempts.
const scriptedCall = (failures: ReadonlyArray<CallError>) =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0);
		const call = Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
			Effect.flatMap((attempt) => (attempt < failures.length ? Effect.fail(failures[attempt]) : Effect.succeed('ok'))),
		);

		return { attempts: Ref.get(attempts), call };
	});

const transient = new Transient({ message: 'HTTP 503' });

describe('withCallPolicy', () => {
	it.effect('retries a Transient failure 3 times with exponential backoff and jitter, then fails', () =>
		Effect.gen(function* () {
			const { attempts, call } = yield* scriptedCall([transient, transient, transient, transient]);
			const fiber = yield* call.pipe(withCallPolicy(callTimeouts.linear), Effect.forkChild);

			yield* Effect.yieldNow;
			assert.strictEqual(yield* attempts, 1);

			// Delays are 1 s, 2 s and 4 s, each scaled by 0.8 to 1.2, so retry n lands between 0.8 and 1.2 times the
			// sum of the first n delays.
			for (const [earliest, latest, attempt] of [
				[800, 1200, 2],
				[2400, 3600, 3],
				[5600, 8400, 4],
			] as const) {
				yield* TestClock.setTime(earliest - 1);
				assert.strictEqual(yield* attempts, attempt - 1);
				yield* TestClock.setTime(latest);
				assert.strictEqual(yield* attempts, attempt);
			}

			const exit = yield* Fiber.await(fiber);

			assert.deepStrictEqual(exit, Exit.fail(transient));
			yield* TestClock.adjust('1 hour');
			assert.strictEqual(yield* attempts, 4);
		}),
	);

	it.effect('does not retry a Permanent failure', () =>
		Effect.gen(function* () {
			const permanent = new Permanent({ message: 'HTTP 404' });
			const { attempts, call } = yield* scriptedCall([permanent]);
			const exit = yield* call.pipe(withCallPolicy(callTimeouts.gh), Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(permanent));
			assert.strictEqual(yield* attempts, 1);
		}),
	);

	it.effect('waits for Retry-After before retrying', () =>
		Effect.gen(function* () {
			const rateLimited = new Transient({ message: 'HTTP 429', retryAfter: Duration.seconds(30) });
			const { attempts, call } = yield* scriptedCall([rateLimited]);
			const fiber = yield* call.pipe(withCallPolicy(callTimeouts.linear), Effect.forkChild);

			yield* TestClock.adjust('29999 millis');
			assert.strictEqual(yield* attempts, 1);
			yield* TestClock.adjust('1 millis');

			assert.strictEqual(yield* Fiber.join(fiber), 'ok');
			assert.strictEqual(yield* attempts, 2);
		}),
	);

	it.effect('times out a hanging attempt as Transient and retries it', () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const call = Ref.updateAndGet(attempts, (n) => n + 1).pipe(Effect.flatMap((attempt) => (attempt === 1 ? Effect.never : Effect.succeed('ok'))));
			const fiber = yield* call.pipe(withCallPolicy(callTimeouts.herdr), Effect.forkChild);

			yield* TestClock.adjust('29 seconds');
			assert.strictEqual(yield* Ref.get(attempts), 1);
			yield* TestClock.adjust('1 second');
			yield* TestClock.adjust('1200 millis');

			assert.strictEqual(yield* Fiber.join(fiber), 'ok');
			assert.strictEqual(yield* Ref.get(attempts), 2);
		}),
	);
});
