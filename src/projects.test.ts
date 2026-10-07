import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Logger } from 'effect';
import { AppConfig } from './config.ts';
import { Refused } from './ctl.ts';
import { Journal } from './journal.ts';
import { Projects } from './projects.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const tempDirectory = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), 'sapphire-agent-projects-'))),
	(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
);

// What the service logged while its Projects started on the journal file, without the rest of each log line.
const start = (journalFile: string, config: Layer.Layer<AppConfig>) =>
	Effect.gen(function* () {
		const logs: Array<{ level: string; message: unknown }> = [];
		const logger = Logger.map(Logger.formatStructured, ({ level, message }) => {
			logs.push({ level, message });
		});
		const projects = yield* Projects.use((service) => service.list).pipe(
			Effect.provide(Projects.layer.pipe(Layer.provide(Journal.layer(journalFile)), Layer.provide(config))),
			Effect.provide(Logger.layer([logger])),
		);

		return { projects, logs };
	});

const withoutTeams = (directory: string) => Layer.effect(AppConfig, AppConfig.useSync(({ teams: _, ...config }) => config)).pipe(Layer.provide(AppConfig.layerTest(directory)));

const teams = {
	teams: {
		Unbound: { repo: '~/unbound', labelReposDirectory: '~/unbound-app' },
		Telecord: { repo: '~/telecord' },
	},
};

describe('Projects', () => {
	it.effect("imports config.json's teams into an empty journal once, and warns to delete them on every start", () =>
		Effect.gen(function* () {
			const directory = yield* tempDirectory;
			const journalFile = join(directory, 'journal.db');
			const first = yield* start(journalFile, AppConfig.layerTest(directory, teams));
			const second = yield* start(journalFile, AppConfig.layerTest(directory, { teams: { Hivemind: { repo: '~/hivemind' } } }));
			const warning = {
				level: 'WARN',
				message: 'config.json still has teams, which are only read into an empty projects table; delete them and use `sapphire project` instead',
			};

			assert.deepStrictEqual(first.projects, [
				{ team: 'Telecord', repo: join(homedir(), 'telecord'), labelReposDirectory: null },
				{ team: 'Unbound', repo: join(homedir(), 'unbound'), labelReposDirectory: join(homedir(), 'unbound-app') },
			]);
			assert.deepStrictEqual(first.logs, [{ level: 'INFO', message: "imported the projects Unbound, Telecord from config.json's teams" }, warning]);
			assert.deepStrictEqual(second.projects, first.projects);
			assert.deepStrictEqual(second.logs, [warning]);
		}).pipe(Effect.scoped),
	);

	it.effect('starts without projects and without a warning from a config.json without teams', () =>
		Effect.gen(function* () {
			const directory = yield* tempDirectory;

			assert.deepStrictEqual(yield* start(join(directory, 'journal.db'), withoutTeams(directory)), { projects: [], logs: [] });
		}).pipe(Effect.scoped),
	);
});

// The project lines and the requests of `sapphire status`.
const status = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('project ') || line.startsWith('request '))));

const refusal = (h: Harness, ...args: ReadonlyArray<string>) =>
	h.ctl(...args).pipe(
		Effect.flip,
		Effect.map((error) => (error instanceof Refused ? error.message : `not refused: ${String(error)}`)),
	);

describe('sapphire project', () => {
	it.effect('refuses an unknown Linear team, a missing path, a repo without a GitHub origin and an existing project, and records nothing', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const missing = join(h.dir, 'nowhere');
			const local = join(h.dir, 'local');

			mkdirSync(local);
			execFileSync('git', ['init', '--quiet', local]);

			assert.strictEqual(yield* refusal(h, 'project', 'add', 'Unknown', h.repo), 'there is no team Unknown in Linear');
			assert.strictEqual(yield* refusal(h, 'project', 'add', 'Test', h.repo), 'project Test exists already; change it with project edit');
			assert.strictEqual(yield* refusal(h, 'project', 'edit', 'Test', '--repo', missing), `${missing} does not exist`);
			assert.strictEqual(yield* refusal(h, 'project', 'edit', 'Test', '--label-repos', missing), `${missing} does not exist`);
			assert.match(yield* refusal(h, 'project', 'edit', 'Test', '--repo', local), new RegExp(`^${local} is not a git repo with a GitHub origin: `));
			assert.strictEqual(yield* refusal(h, 'project', 'edit', 'Test'), 'give --repo, --label-repos, or both');
			assert.strictEqual(yield* refusal(h, 'project', 'edit', 'Other', '--repo', h.repo), 'there is no project Other');
			assert.strictEqual(yield* refusal(h, 'project', 'remove', 'Other'), 'there is no project Other');
			assert.deepStrictEqual(yield* status(h), [`project Test: ${h.repo}`]);
		}),
	);

	it.effect('applies a remove, an add and an edit on the next tick, and lists them', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const apps = join(h.dir, 'apps');

			mkdirSync(apps);

			assert.deepStrictEqual(yield* h.ctl('project', 'remove', 'Test'), ['project Test is removed on the next tick']);
			assert.deepStrictEqual(yield* status(h), [`project Test: ${h.repo}`, 'request 1: remove project Test']);
			yield* h.tick;
			assert.deepStrictEqual(yield* h.ctl('project', 'list'), ['no projects']);

			assert.deepStrictEqual(yield* h.ctl('project', 'add', 'Test', h.repo), ['project Test is added on the next tick']);
			yield* h.tick;
			assert.deepStrictEqual(yield* h.ctl('project', 'list'), [`project Test: ${h.repo}`]);

			assert.deepStrictEqual(yield* h.ctl('project', 'edit', 'Test', '--label-repos', apps), ['project Test is changed on the next tick']);
			yield* h.tick;

			assert.deepStrictEqual(yield* status(h), [`project Test: ${h.repo}, label repos in ${apps}`]);
			assert.deepStrictEqual(yield* h.ctl('project', 'list'), [`project Test: ${h.repo}, label repos in ${apps}`]);
		}),
	);

	it.effect('refuses to remove a project while a run of its team is in flight, in the CLI and on the tick', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			// As the CLI recorded it before the run was claimed.
			yield* Journal.use((journal) => journal.addRequest({ _tag: 'project-remove', team: 'Test' })).pipe(Effect.provide(Journal.layer(join(h.dir, 'journal.db'))));

			assert.strictEqual(yield* refusal(h, 'project', 'remove', 'Test'), 'project Test has a run in flight; stop it first');

			yield* h.tick;

			assert.deepStrictEqual(yield* status(h), [`project Test: ${h.repo}`]);
		}),
	);

	it.effect('dispatches a repo-labelled epic into the label repos directory of its project', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const apps = join(h.dir, 'apps');
			const label = h.linear.addLabel({ name: 'repo:loader' });

			mkdirSync(apps);
			execFileSync('git', ['clone', '--quiet', h.origin, join(apps, 'loader')]);
			h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync', labelIds: [label.id] });

			yield* h.ctl('project', 'edit', 'Test', '--label-repos', apps);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map(({ repo, status }) => ({ repo, status })),
				[{ repo: join(apps, 'loader'), status: 'running' }],
			);
		}),
	);
});
