import { assert, describe, it } from '@effect/vitest';
import { Data, Deferred, Duration, Effect, Layer, Logger, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { Permanent, Transient } from './call-policy.ts';
import { LinearFixture } from './linear-fixture.ts';
import { Journal } from './journal.ts';
import { type Observation, Observer } from './observation.ts';
import { Planner, type Rule } from './planner.ts';
import { FakePushover } from './pushover-fake.ts';
import { emptyObservation, plannerDependencies } from './test-harness.ts';

class Bug extends Data.TaggedError('Bug')<{ readonly message: string }> {}

const tickWith = (rules: ReadonlyArray<Rule>) =>
	Planner.use((planner) => planner.tick({ paused: false })).pipe(Effect.provide(Planner.layer(Effect.succeed(rules))));

const withPlanner = (settings: Parameters<typeof plannerDependencies>[1] = {}) => Effect.provide(plannerDependencies('/tmp/sapphire-agent-planner-test', settings));

// One rule whose work for the epic fails with whatever `outcome` holds at the time.
const failingRule = (epicId: string, identifier: string, outcome: Ref.Ref<Effect.Effect<void, Transient | Permanent>>): Rule => ({
	name: 'results',
	pausable: false,
	plan: () => Effect.succeed([{ epicId, identifier, teamId: 'team-test', apply: Effect.flatten(Ref.get(outcome)) }]),
});

// The rules here send nothing, so the outbox holds every notice written.
const notices = Journal.use((journal) => journal.unsentNotices).pipe(Effect.map((rows) => rows.map(({ purpose, key, text }) => ({ marker: `${purpose}:${key}`, text }))));

describe('Planner', () => {
	it.effect('runs each epic in its own fiber, logs failures with the epic and moves on', () =>
		Effect.gen(function* () {
			const bug = new Bug({ message: 'tail parser blew up' });
			const bothStarted = yield* Deferred.make<void>();
			const applied = yield* Ref.make<ReadonlyArray<string>>([]);
			const record = (entry: string) => Ref.update(applied, (entries) => [...entries, entry]);
			const work = (identifier: string, apply: Effect.Effect<void, unknown>) => ({ epicId: `issue-${identifier.toLowerCase()}`, identifier, teamId: 'team-test', apply });
			const monitoring: Rule = {
				name: 'monitoring',
				pausable: false,
				plan: () =>
					Effect.succeed([
						// HL-1 waits for HL-2, which only works if they run concurrently.
						work('HL-1', Deferred.await(bothStarted).pipe(Effect.andThen(Effect.fail(bug)))),
						work('HL-2', record('monitoring HL-2').pipe(Effect.andThen(Deferred.succeed(bothStarted, undefined)))),
					]),
			};
			const results: Rule = { name: 'results', pausable: false, plan: () => Effect.fail(bug) };
			const cleanup: Rule = { name: 'cleanup', pausable: false, plan: () => Effect.succeed([work('HL-3', record('cleanup HL-3'))]) };
			const logs: Array<{ level: string; message: unknown; annotations: Record<string, unknown>; cause: string | undefined }> = [];
			const logger = Logger.map(Logger.formatStructured, (line) => {
				logs.push(line);
			});

			yield* tickWith([monitoring, results, cleanup]).pipe(Effect.provide(Logger.layer([logger])));

			assert.deepStrictEqual(yield* Ref.get(applied), ['monitoring HL-2', 'cleanup HL-3']);
			assert.deepStrictEqual(
				logs.map(({ level, message, annotations }) => ({ level, message, annotations })),
				[
					{ level: 'ERROR', message: 'failed', annotations: { rule: 'monitoring', epic: 'HL-1' } },
					{ level: 'ERROR', message: 'planning failed', annotations: { rule: 'results' } },
				],
			);
			assert.match(logs[0].cause ?? '', /tail parser blew up/);
		}).pipe(withPlanner()),
	);

	it.effect('flags an epic once its transient failures outlast flagTransientAfterSeconds, once, and starts over after a success', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Flaky T3', state: 'Implementing' });
			const t3Down = Effect.fail(new Transient({ message: 'T3 could not be reached: fetch failed' }));
			const outcome = yield* Ref.make<Effect.Effect<void, Transient | Permanent>>(t3Down);
			const tick = tickWith([failingRule(epic.id, 'TEST-10', outcome)]);

			yield* tick;
			yield* TestClock.adjust('9 minutes');
			yield* tick;
			assert.deepStrictEqual(yield* notices, []);

			yield* TestClock.adjust('1 minute');
			yield* tick;
			yield* TestClock.adjust('5 minutes');
			yield* tick;
			assert.deepStrictEqual(
				(yield* notices).map(({ marker }) => marker),
				['transientFailure:0'],
			);
			assert.match((yield* notices)[0].text, /^⚠️ \*\*TEST-10's calls keep failing\*\* for 10 min: T3 could not be reached: fetch failed/);
			assert.deepStrictEqual(fixture.labelNames(epic.id), []);
			assert.deepStrictEqual(fixture.comments(epic.id), []);

			yield* Ref.set(outcome, Effect.void);
			yield* tick;
			yield* Ref.set(outcome, t3Down);
			yield* tick;
			yield* TestClock.adjust('10 minutes');
			yield* tick;
			assert.deepStrictEqual(
				(yield* notices).map(({ marker }) => marker),
				['transientFailure:0', `transientFailure:${Duration.toMillis('15 minutes')}`],
			);
		}).pipe(withPlanner({ flagTransientAfterSeconds: 600 })),
	);

	it.effect('flags a permanent failure once per run, with the stuck label', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const epic = fixture.addEpic({ identifier: 'TEST-11', title: 'Broken repo label' });
			const outcome = yield* Ref.make<Effect.Effect<void, Transient | Permanent>>(Effect.fail(new Permanent({ message: 'gh api: HTTP 422: Validation Failed' })));
			const tick = tickWith([failingRule(epic.id, 'TEST-11', outcome)]);

			yield* tick;
			yield* TestClock.adjust('1 minute');
			yield* tick;

			assert.deepStrictEqual(
				(yield* notices).map(({ marker }) => marker),
				['permanentFailure:0'],
			);
			assert.match((yield* notices)[0].text, /^🔴 \*\*A call for TEST-11 failed for good\*\*: gh api: HTTP 422: Validation Failed/);
			assert.deepStrictEqual(fixture.comments(epic.id), []);
			assert.deepStrictEqual(fixture.labelNames(epic.id), ['agent-stuck']);
		}).pipe(withPlanner()),
	);

	it.effect('tells Pushover, once per streak, when observing has failed for flagTransientAfterSeconds', () =>
		Effect.gen(function* () {
			const pushover = yield* FakePushover;
			const linearDown = Effect.fail(new Transient({ message: 'Linear could not be reached: fetch failed' }));
			const observed = yield* Ref.make<Effect.Effect<Observation, Transient>>(linearDown);
			const planner = yield* Planner.pipe(Effect.provide(Planner.layer(Effect.succeed([])).pipe(Layer.provide(Layer.succeed(Observer, { observe: Effect.flatten(Ref.get(observed)) })))));
			const tick = planner.tick({ paused: false });

			yield* tick;
			yield* TestClock.adjust('9 minutes');
			yield* tick;
			assert.deepStrictEqual(pushover.sent(), []);

			yield* TestClock.adjust('1 minute');
			yield* tick;
			yield* TestClock.adjust('5 minutes');
			yield* tick;
			assert.deepStrictEqual(pushover.sent(), [
				{
					title: 'sapphire-agent cannot observe',
					message: 'Reading Linear or the journal has failed for 10 min, so no epic is dispatched or watched: Linear could not be reached: fetch failed',
					priority: 'high',
				},
			]);

			yield* Ref.set(observed, Effect.succeed(emptyObservation));
			yield* tick;
			yield* Ref.set(observed, linearDown);
			yield* tick;
			yield* TestClock.adjust('10 minutes');
			yield* tick;
			assert.lengthOf(pushover.sent(), 2);
		}).pipe(withPlanner({ flagTransientAfterSeconds: 600 })),
	);

	it.effect('tries Pushover again on the next failed observation when sending failed', () =>
		Effect.gen(function* () {
			const pushover = yield* FakePushover;
			const planner = yield* Planner.pipe(
				Effect.provide(Planner.layer(Effect.succeed([])).pipe(Layer.provide(Layer.succeed(Observer, { observe: Effect.fail(new Transient({ message: 'Linear could not be reached: fetch failed' })) })))),
			);

			yield* planner.tick({ paused: false });
			yield* TestClock.adjust('1 minute');
			pushover.failNext(1);
			yield* planner.tick({ paused: false });
			assert.deepStrictEqual(pushover.sent(), []);

			yield* planner.tick({ paused: false });
			assert.deepStrictEqual(
				pushover.sent().map(({ title }) => title),
				['sapphire-agent cannot observe'],
			);
		}).pipe(withPlanner({ flagTransientAfterSeconds: 60 })),
	);

	it.effect('skips the rest of the tick after a rate limit', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const epic = fixture.addEpic({ identifier: 'TEST-12', title: 'Busy workspace', state: 'Implementing' });
			const applied = yield* Ref.make(0);
			const rateLimited = yield* Ref.make<Effect.Effect<void, Transient | Permanent>>(
				Effect.fail(new Transient({ message: 'Linear answered HTTP 400: rate limited', retryAfter: Duration.seconds(30) })),
			);
			const later: Rule = { name: 'dispatch', pausable: true, plan: () => Effect.succeed([{ epicId: epic.id, identifier: 'TEST-12', teamId: 'team-test', apply: Ref.update(applied, (count) => count + 1) }]) };

			yield* tickWith([failingRule(epic.id, 'TEST-12', rateLimited), later]);
			assert.strictEqual(yield* Ref.get(applied), 0);

			yield* Ref.set(rateLimited, Effect.void);
			yield* tickWith([failingRule(epic.id, 'TEST-12', rateLimited), later]);
			assert.strictEqual(yield* Ref.get(applied), 1);
		}).pipe(withPlanner()),
	);
});
