import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect, FileSystem, Layer, Option, PlatformError, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { Pause } from './pause.ts';
import { Planner, type Rule } from './planner.ts';
import { FakePushover } from './pushover-fake.ts';
import { Reconciler } from './reconciler.ts';
import { FakeT3 } from './t3-fake.ts';
import { plannerDependencies } from './test-harness.ts';

// A dispatch-like rule (skipped while paused) and a monitoring-like rule, each reporting `<rule>@<seconds>` per tick.
const setup = (pauseLayer = Pause.layer) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
		const ticks = yield* Queue.unbounded<string>();
		const rule = (name: string, pausable: boolean): Rule => ({
			name,
			pausable,
			plan: () =>
				Effect.succeed([
					{
						epicId: 'issue-hl-9',
						identifier: 'HL-9',
						teamId: 'team-test',
						apply: Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Queue.offer(ticks, `${name}@${now / 1000}`))),
					},
				]),
		});
		const { reconciler, pushover, t3 } = yield* Effect.all({ reconciler: Reconciler, pushover: FakePushover, t3: FakeT3 }).pipe(
			Effect.provide(
				Reconciler.layer.pipe(
					Layer.provide(Planner.layer(Effect.succeed([rule('dispatch', true), rule('monitoring', false)]))),
					Layer.provide(pauseLayer),
					Layer.provideMerge(plannerDependencies(directory, { pollSeconds: 30 })),
				),
			),
		);
		const pauseFile = join(directory, 'paused');

		return {
			reconciler,
			pause: fs.writeFileString(pauseFile, '').pipe(Effect.orDie),
			resume: fs.remove(pauseFile).pipe(Effect.orDie),
			nextTick: Effect.all([Queue.take(ticks), Queue.take(ticks)]),
			nextPausedTick: Queue.take(ticks),
			pushover,
			t3,
			noTick: Queue.poll(ticks).pipe(Effect.map(Option.isNone)),
		};
	}).pipe(Effect.provide(NodeFileSystem.layer));

describe('Reconciler', () => {
	it.effect('ticks at once, then every pollSeconds', () =>
		Effect.gen(function* () {
			const { reconciler, nextTick, noTick } = yield* setup();

			yield* Effect.forkScoped(reconciler.run);
			assert.deepStrictEqual(yield* nextTick, ['dispatch@0', 'monitoring@0']);

			yield* TestClock.adjust('29 seconds');
			assert.isTrue(yield* noTick);

			yield* TestClock.adjust('1 second');
			assert.deepStrictEqual(yield* nextTick, ['dispatch@30', 'monitoring@30']);

			yield* TestClock.adjust('30 seconds');
			assert.deepStrictEqual(yield* nextTick, ['dispatch@60', 'monitoring@60']);
		}),
	);

	it.effect('ticks early when woken', () =>
		Effect.gen(function* () {
			const { reconciler, nextTick, noTick } = yield* setup();

			yield* Effect.forkScoped(reconciler.run);
			yield* nextTick;
			yield* TestClock.adjust('10 seconds');
			assert.isTrue(yield* noTick);

			yield* reconciler.wake;
			assert.deepStrictEqual(yield* nextTick, ['dispatch@10', 'monitoring@10']);

			yield* TestClock.adjust('20 seconds');
			assert.deepStrictEqual(yield* nextTick, ['dispatch@30', 'monitoring@30']);
		}),
	);

	it.effect('skips dispatch-type rules while paused and keeps watching runs in flight', () =>
		Effect.gen(function* () {
			const { reconciler, pause, resume, nextTick, nextPausedTick, noTick } = yield* setup();

			yield* pause;
			yield* Effect.forkScoped(reconciler.run);
			assert.strictEqual(yield* nextPausedTick, 'monitoring@0');

			yield* TestClock.adjust('30 seconds');
			assert.strictEqual(yield* nextPausedTick, 'monitoring@30');
			assert.isTrue(yield* noTick);

			yield* resume;
			yield* TestClock.adjust('30 seconds');
			assert.deepStrictEqual(yield* nextTick, ['dispatch@60', 'monitoring@60']);
		}),
	);

	it.effect('starts no new runs and tells Pushover once while the pause file cannot be read', () =>
		Effect.gen(function* () {
			const unreadable = PlatformError.systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'exists', pathOrDescriptor: '/state/paused' });
			const { reconciler, nextPausedTick, noTick, pushover } = yield* setup(Layer.succeed(Pause, { path: '/state/paused', isPaused: Effect.fail(unreadable), pause: Effect.void, resume: Effect.void }));

			yield* Effect.forkScoped(reconciler.run);
			assert.strictEqual(yield* nextPausedTick, 'monitoring@0');

			yield* TestClock.adjust('30 seconds');
			assert.strictEqual(yield* nextPausedTick, 'monitoring@30');
			assert.isTrue(yield* noTick);
			assert.deepStrictEqual(
				pushover.sent().map(({ title, priority }) => [title, priority]),
				[['sapphire-agent cannot read its pause file', 'high']],
			);
		}),
	);

	it.effect('starts no new runs while T3 rejects the token, telling Pushover once how to fix it, and starts them again once T3 accepts a new one', () =>
		Effect.gen(function* () {
			const { reconciler, nextTick, nextPausedTick, noTick, pushover, t3 } = yield* setup();

			yield* t3.rejectToken(true);
			yield* Effect.forkScoped(reconciler.run);
			assert.strictEqual(yield* nextPausedTick, 'monitoring@0');

			yield* TestClock.adjust('30 seconds');
			assert.strictEqual(yield* nextPausedTick, 'monitoring@30');
			assert.isTrue(yield* noTick);

			yield* t3.rejectToken(false);
			yield* TestClock.adjust('30 seconds');
			assert.deepStrictEqual(yield* nextTick, ['dispatch@60', 'monitoring@60']);

			// Rejected again within the day: no second notice.
			yield* t3.rejectToken(true);
			yield* TestClock.adjust('30 seconds');
			assert.strictEqual(yield* nextPausedTick, 'monitoring@90');
			assert.deepStrictEqual(
				pushover.sent().map(({ title, message, priority }) => [title, message, priority]),
				[
					[
						'T3 rejects the sapphire-agent token',
						`No new run starts until T3 accepts the token in ${join(homedir(), '.config/sapphire-agent/t3-token')}. Run scripts/mint-t3-token.sh again to write a new one. T3 said: T3 answered HTTP 401: {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}`,
						'high',
					],
				],
			);
		}),
	);
});
