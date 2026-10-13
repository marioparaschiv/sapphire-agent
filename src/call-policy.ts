import { Duration, Effect, type PlatformError, Schedule, Schema } from 'effect';
import type { HttpClientError } from 'effect/http';

// Worth retrying: a timeout, a 5xx, a network error, a git lock. `retryAfter` is the server's Retry-After.
export class Transient extends Schema.TaggedError<Transient>()('Transient', {
	message: Schema.String,
	retryAfter: Schema.optionalKey(Schema.Duration),
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

// Retrying cannot help: a 4xx, a decode failure, a missing repo.
export class Permanent extends Schema.TaggedError<Permanent>()('Permanent', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type CallError = Transient | Permanent;

export const transportFailure = (service: string) => (error: HttpClientError.HttpClientError) =>
	error.reason._tag === 'TransportError'
		? new Transient({ message: `${service} could not be reached: ${error.message}`, cause: error })
		: new Permanent({ message: `${service} request failed: ${error.message}`, cause: error });

export const fileSystemFailure = (error: PlatformError.PlatformError) => new Permanent({ message: error.message, cause: error });

export const callTimeouts = {
	t3: Duration.seconds(30),
	git: Duration.seconds(30),
	gh: Duration.seconds(20),
	linear: Duration.seconds(20),
	pushover: Duration.seconds(20),
	claude: Duration.seconds(60),
} as const;

const maxRetries = 3;

// A call may fail with errors of its own besides CallError (e.g. T3 rejecting the token); only Transient is retried.
type Tagged = { readonly _tag: string };

// 1 s, 2 s, 4 s, each jittered by up to 20 %, unless the error says how long to wait.
const retrySchedule = Schedule.exponential('1 second').pipe(
	Schedule.jittered,
	Schedule.setInputType<Tagged>(),
	Schedule.modifyDelay(({ input, duration }) => Effect.succeed(input instanceof Transient && input.retryAfter ? input.retryAfter : duration)),
);

// One attempt with a timeout, e.g. a probe that a tick waits on.
export const timeoutAsTransient =
	(timeout: Duration.Duration) =>
	<A, E extends Tagged, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | Transient, R> =>
		call.pipe(
			Effect.timeoutOrElse({
				duration: timeout,
				orElse: () => Effect.fail(new Transient({ message: `timed out after ${Duration.format(timeout)}` })),
			}),
		);

const retryTransient = <A, E extends Tagged, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	call.pipe(Effect.retry({ schedule: retrySchedule, times: maxRetries, while: (error) => error._tag === 'Transient' }));

// Every external call goes through this: a timeout per attempt, and up to 3 retries of a Transient failure.
// Once the retries are used up the Transient fails the call; the next tick tries again.
export const withCallPolicy =
	(timeout: Duration.Duration) =>
	<A, E extends Tagged, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | Transient, R> =>
		call.pipe(timeoutAsTransient(timeout), retryTransient);

// For writes with no marker to check first (a T3 launch, a phone notification): a timed-out attempt may still have
// landed, so the timeout covers all attempts and is never retried. The next tick observes what happened.
export const withWritePolicy =
	(timeout: Duration.Duration) =>
	<A, E extends Tagged, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | Transient, R> =>
		call.pipe(retryTransient, timeoutAsTransient(timeout));
