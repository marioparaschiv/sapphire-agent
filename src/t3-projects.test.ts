import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { Journal } from './journal.ts';
import { T3Unauthorized } from './t3.ts';
import { FakeT3 } from './t3-fake.ts';
import { T3Projects } from './t3-projects.ts';

const layer = T3Projects.layer.pipe(Layer.provideMerge(Layer.mergeAll(FakeT3.layer, Journal.layer(':memory:'))));

describe('T3Projects', () => {
	it.effect("finds a repo's T3 project by its workspace root and remembers it, so later lookups ask T3 nothing", () =>
		Effect.gen(function* () {
			const fake = yield* FakeT3;
			const t3Projects = yield* T3Projects;
			const telecord = yield* fake.addProject('/home/dev/telecord');

			assert.strictEqual(yield* t3Projects.projectFor('/home/dev/telecord'), telecord.id);
			assert.strictEqual(yield* t3Projects.projectFor('/home/dev/telecord'), telecord.id);
			assert.deepStrictEqual(yield* Journal.use((journal) => journal.getT3Project('/home/dev/telecord')), Option.some(telecord.id));
			assert.deepStrictEqual(yield* fake.calls, ['t3_project_list']);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('creates the T3 project of a team repo and of a label repo that have none, each once even when looked up at the same time', () =>
		Effect.gen(function* () {
			const fake = yield* FakeT3;
			const t3Projects = yield* T3Projects;

			yield* fake.addProject('/home/dev/telecord');

			const ids = yield* Effect.forEach(['/home/dev/unbound', '/home/dev/unbound-app/desktop', '/home/dev/unbound', '/home/dev/unbound-app/desktop'], t3Projects.projectFor, {
				concurrency: 'unbounded',
			});
			const projects = yield* fake.projects;

			assert.deepStrictEqual(
				projects.map(({ title, workspaceRoot }) => [title, workspaceRoot]),
				[
					['telecord', '/home/dev/telecord'],
					['unbound', '/home/dev/unbound'],
					['desktop', '/home/dev/unbound-app/desktop'],
				],
			);
			assert.deepStrictEqual(ids, [projects[1].id, projects[2].id, projects[1].id, projects[2].id]);
			assert.deepStrictEqual((yield* fake.calls).filter((tool) => tool === 't3_project_create'), ['t3_project_create', 't3_project_create']);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('fails T3Unauthorized and remembers nothing while T3 rejects the token', () =>
		Effect.gen(function* () {
			const fake = yield* FakeT3;

			yield* fake.rejectToken(true);

			const error = yield* T3Projects.use((t3Projects) => t3Projects.projectFor('/home/dev/unbound')).pipe(Effect.flip);

			assert.instanceOf(error, T3Unauthorized);
			assert.deepStrictEqual(yield* Journal.use((journal) => journal.getT3Project('/home/dev/unbound')), Option.none());
			assert.deepStrictEqual(yield* fake.projects, []);
		}).pipe(Effect.provide(layer)),
	);
});
