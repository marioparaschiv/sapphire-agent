import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect, FileSystem, Layer, Option, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { AppConfig } from './config.ts';
import { Pause } from './pause.ts';
import { Planner, type Rule } from './planner.ts';
import { Reconciler } from './reconciler.ts';

// A dispatch-like rule (skipped while paused) and a monitoring-like rule, each reporting `<rule>@<seconds>` per tick.
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
	const ticks = yield* Queue.unbounded<string>();
	const rule = (name: string, pausable: boolean): Rule => ({
		name,
		pausable,
		plan: Effect.succeed([
			{ identifier: 'HL-9', apply: Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Queue.offer(ticks, `${name}@${now / 1000}`))) },
		]),
	});
	const reconciler = yield* Reconciler.pipe(
		Effect.provide(
			Reconciler.layer.pipe(
				Layer.provide(Planner.layer(Effect.succeed([rule('dispatch', true), rule('monitoring', false)]))),
				Layer.provide(Pause.layer),
				Layer.provideMerge(AppConfig.layerTest(directory, { pollSeconds: 30 })),
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
		noTick: Queue.poll(ticks).pipe(Effect.map(Option.isNone)),
	};
}).pipe(Effect.provide(NodeFileSystem.layer));

describe('Reconciler', () => {
	it.effect('ticks at once, then every pollSeconds', () =>
		Effect.gen(function* () {
			const { reconciler, nextTick, noTick } = yield* setup;

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
			const { reconciler, nextTick, noTick } = yield* setup;

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
			const { reconciler, pause, resume, nextTick, nextPausedTick, noTick } = yield* setup;

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
});
