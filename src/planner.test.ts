import { assert, describe, it } from '@effect/vitest';
import { Data, Deferred, Duration, Effect, Logger, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { Permanent, Transient } from './call-policy.ts';
import { LinearFixture } from './linear-fixture.ts';
import { parseMarker } from './markers.ts';
import { Planner, type Rule } from './planner.ts';
import { plannerDependencies } from './test-harness.ts';

class Bug extends Data.TaggedError('Bug')<{ readonly message: string }> {}

const tickWith = (rules: ReadonlyArray<Rule>) =>
	Planner.use((planner) => planner.tick({ paused: false })).pipe(Effect.provide(Planner.layer(Effect.succeed(rules))));

const withPlanner = (settings: Parameters<typeof plannerDependencies>[1] = {}) => Effect.provide(plannerDependencies('/tmp/herdr-linear-planner-test', settings));

// One rule whose work for the epic fails with whatever `outcome` holds at the time.
const failingRule = (epicId: string, identifier: string, outcome: Ref.Ref<Effect.Effect<void, Transient | Permanent>>): Rule => ({
	name: 'results',
	pausable: false,
	plan: () => Effect.succeed([{ epicId, identifier, teamId: 'team-test', apply: Effect.flatten(Ref.get(outcome)) }]),
});

const markers = (fixture: LinearFixture['Service'], issueId: string) =>
	fixture.comments(issueId).map((comment) => {
		const marker = parseMarker(comment.body);

		return marker._tag === 'Some' ? `${marker.value.purpose}:${marker.value.key}` : comment.body;
	});

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
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Flaky herdr', state: 'Implementing' });
			const herdrDown = Effect.fail(new Transient({ message: 'herdr pane read: server_not_running' }));
			const outcome = yield* Ref.make<Effect.Effect<void, Transient | Permanent>>(herdrDown);
			const tick = tickWith([failingRule(epic.id, 'TEST-10', outcome)]);

			yield* tick;
			yield* TestClock.adjust('9 minutes');
			yield* tick;
			assert.deepStrictEqual(fixture.comments(epic.id), []);

			yield* TestClock.adjust('1 minute');
			yield* tick;
			yield* TestClock.adjust('5 minutes');
			yield* tick;
			assert.deepStrictEqual(markers(fixture, epic.id), ['transientFailure:0']);
			assert.match(fixture.comments(epic.id)[0].body, /calls for this epic have been failing for 10 min: herdr pane read: server_not_running/);
			assert.deepStrictEqual(fixture.labelNames(epic.id), []);

			yield* Ref.set(outcome, Effect.void);
			yield* tick;
			yield* Ref.set(outcome, herdrDown);
			yield* tick;
			yield* TestClock.adjust('10 minutes');
			yield* tick;
			assert.deepStrictEqual(markers(fixture, epic.id), ['transientFailure:0', `transientFailure:${Duration.toMillis('15 minutes')}`]);
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

			assert.deepStrictEqual(markers(fixture, epic.id), ['permanentFailure:0']);
			assert.match(fixture.comments(epic.id)[0].body, /retrying cannot help: gh api: HTTP 422: Validation Failed/);
			assert.deepStrictEqual(fixture.labelNames(epic.id), ['agent-stuck']);
		}).pipe(withPlanner()),
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
