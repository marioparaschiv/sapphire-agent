import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Redacted } from 'effect';
import { loadAppConfig } from './config.ts';

const load = (env: Record<string, string>, files: { config?: unknown; key?: { text: string; mode: number } }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);

		if (files.config !== undefined) {
			const text = typeof files.config === 'string' ? files.config : JSON.stringify(files.config);
			yield* fs.writeFileString(join(directory, 'config.json'), text).pipe(Effect.orDie);
		}

		if (files.key) {
			yield* fs.writeFileString(join(directory, 'linear-key'), files.key.text, { mode: files.key.mode }).pipe(Effect.orDie);
		}

		const provider = ConfigProvider.fromEnvRecord({
			HERDR_PLUGIN_CONFIG_DIR: directory,
			HERDR_LINEAR_KEY_FILE: join(directory, 'linear-key'),
			...env,
		});

		return yield* loadAppConfig.pipe(Effect.provide(ConfigProvider.layer(provider)));
	}).pipe(Effect.provide(NodeFileSystem.layer));

const fullEnv = { HERDR_BIN_PATH: '/bin/herdr', HERDR_SOCKET_PATH: '/run/herdr.sock', HERDR_PLUGIN_STATE_DIR: '/state' };
const key = { text: 'lin_api_secret\n', mode: 0o600 };
const bot = { login: 'orchestratorbot', ghConfigDirectory: '~/.config/gh-orchestratorbot' };

describe('loadAppConfig', () => {
	it.effect('fills defaults, expands ~ and reads the old stuckAfterSeconds key', () =>
		Effect.gen(function* () {
			const config = yield* load(fullEnv, { config: { stuckAfterSeconds: 240, teams: { Telecord: { repo: '~/telecord' } }, bot }, key });

			assert.strictEqual(config.pollSeconds, 30);
			assert.strictEqual(config.maxInFlight, 1);
			assert.strictEqual(config.awaitingInputAfterSeconds, 240);
			assert.strictEqual(config.flagTransientAfterSeconds, 600);
			assert.strictEqual(config.states.ready, 'Ready For Agent');
			assert.strictEqual(config.labels.stuck, 'agent-stuck');
			assert.strictEqual(config.worktreesDirectory, join(homedir(), '.herdr/worktrees'));
			assert.deepStrictEqual(config.teams, { Telecord: { repo: join(homedir(), 'telecord') } });
			assert.deepStrictEqual(config.bot, { login: 'orchestratorbot', ghConfigDirectory: join(homedir(), '.config/gh-orchestratorbot') });
			assert.isFalse('stuckAfterSeconds' in config);
			assert.strictEqual(config.env.claudeConfigPath, join(homedir(), '.claude.json'));
			assert.strictEqual(config.env.stateDirectory, '/state');
			assert.strictEqual(Redacted.value(config.linearApiKey), 'lin_api_secret');
		}),
	);

	it.effect('reports an env error and two config file errors together in one message', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const error = yield* load(env, { config: { pollSeconds: 2, maxInflight: 3, teams: { Unbound: { repo: '~/unbound' } }, bot }, key }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 3);
			assert.match(error.message, /HERDR_BIN_PATH/);
			assert.match(error.message, /config\.json pollSeconds: Expected a value greater than or equal to 5/);
			assert.match(error.message, /config\.json maxInflight: Expected no excess property/);
		}),
	);

	it.effect('reports a missing config file and an unsafe key file', () =>
		Effect.gen(function* () {
			const error = yield* load(fullEnv, { key: { text: 'secret', mode: 0o644 } }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 2);
			assert.match(error.problems[0], /config\.json/);
			assert.match(error.problems[1], /readable by other users; run chmod 600/);
		}),
	);

	it.effect('rejects an empty team map, an unknown team key, a missing or incomplete bot and invalid JSON', () =>
		Effect.gen(function* () {
			const noTeams = yield* load(fullEnv, { config: { teams: {}, bot }, key }).pipe(Effect.flip);
			const unknownKey = yield* load(fullEnv, { config: { teams: { Unbound: { repo: '~/unbound', repos: '~/x' } }, bot }, key }).pipe(Effect.flip);
			const noBot = yield* load(fullEnv, { config: { teams: { Unbound: { repo: '~/unbound' } } }, key }).pipe(Effect.flip);
			const noBotLogin = yield* load(fullEnv, { config: { teams: { Unbound: { repo: '~/unbound' } }, bot: { login: '', ghConfigDirectory: '~/gh' } }, key }).pipe(Effect.flip);
			const badJson = yield* load(fullEnv, { config: '{ "teams": ', key }).pipe(Effect.flip);

			assert.match(noTeams.message, /no teams configured/);
			assert.match(unknownKey.message, /repos/);
			assert.match(noBot.message, /config\.json bot: Missing key/);
			assert.match(noBotLogin.message, /config\.json bot\.login: /);
			assert.match(badJson.message, /config\.json/);
		}),
	);

	it.effect('reports a missing API key file', () =>
		Effect.gen(function* () {
			const error = yield* load(fullEnv, { config: { teams: { Unbound: { repo: '~/unbound' } }, bot } }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 1);
			assert.match(error.problems[0], /no Linear API key: create .*linear-key with mode 600/);
		}),
	);
});
