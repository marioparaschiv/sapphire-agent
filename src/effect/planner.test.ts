import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Logger, Ref } from 'effect';
import { Permanent } from './call-policy.ts';
import { Planner, type Rule } from './planner.ts';

describe('Planner', () => {
	it.effect('runs each epic in its own fiber, logs failures with the epic and moves on', () =>
		Effect.gen(function* () {
			const herdrDown = new Permanent({ message: 'herdr is not running' });
			const bothStarted = yield* Deferred.make<void>();
			const applied = yield* Ref.make<ReadonlyArray<string>>([]);
			const record = (entry: string) => Ref.update(applied, (entries) => [...entries, entry]);
			const monitoring: Rule = {
				name: 'monitoring',
				pausable: false,
				plan: Effect.succeed([
					// HL-1 waits for HL-2, which only works if they run concurrently.
					{ identifier: 'HL-1', apply: Deferred.await(bothStarted).pipe(Effect.andThen(Effect.fail(herdrDown))) },
					{ identifier: 'HL-2', apply: record('monitoring HL-2').pipe(Effect.andThen(Deferred.succeed(bothStarted, undefined))) },
				]),
			};
			const results: Rule = { name: 'results', pausable: false, plan: Effect.fail(herdrDown) };
			const cleanup: Rule = { name: 'cleanup', pausable: false, plan: Effect.succeed([{ identifier: 'HL-3', apply: record('cleanup HL-3') }]) };
			const logs: Array<{ level: string; message: unknown; annotations: Record<string, unknown>; cause: string | undefined }> = [];
			const logger = Logger.map(Logger.formatStructured, (line) => {
				logs.push(line);
			});

			yield* Planner.use((planner) => planner.tick({ paused: false })).pipe(
				Effect.provide(Planner.layer(Effect.succeed([monitoring, results, cleanup]))),
				Effect.provide(Logger.layer([logger])),
			);

			assert.deepStrictEqual(yield* Ref.get(applied), ['monitoring HL-2', 'cleanup HL-3']);
			assert.deepStrictEqual(
				logs.map(({ level, message, annotations }) => ({ level, message, annotations })),
				[
					{ level: 'ERROR', message: 'failed', annotations: { rule: 'monitoring', epic: 'HL-1' } },
					{ level: 'ERROR', message: 'planning failed', annotations: { rule: 'results' } },
				],
			);
			assert.match(logs[0].cause ?? '', /herdr is not running/);
		}),
	);
});
