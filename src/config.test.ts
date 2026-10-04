import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Redacted } from 'effect';
import { loadAppConfig } from './config.ts';

type SecretFile = { text: string; mode: number };

// `config` gets the temp directory the files are written to.
const load = (env: Record<string, string>, files: { config?: (directory: string) => unknown; key?: SecretFile; appKey?: SecretFile }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
		const config = files.config?.(directory);

		if (config !== undefined) {
			const text = typeof config === 'string' ? config : JSON.stringify(config);
			yield* fs.writeFileString(join(directory, 'config.json'), text).pipe(Effect.orDie);
		}

		if (files.key) {
			yield* fs.writeFileString(join(directory, 'linear-key'), files.key.text, { mode: files.key.mode }).pipe(Effect.orDie);
		}

		if (files.appKey) {
			yield* fs.writeFileString(join(directory, 'app.pem'), files.appKey.text, { mode: files.appKey.mode }).pipe(Effect.orDie);
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
const appPem = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
const appKey = { text: appPem, mode: 0o600 };
const bot = (directory: string) => ({
	login: 'orchestratorbot',
	ghConfigDirectory: '~/.config/gh-orchestratorbot',
	app: { id: 424242, privateKeyFile: join(directory, 'app.pem') },
	allowedUsers: ['marioparaschiv'],
});
const unbound = (directory: string) => ({ teams: { Unbound: { repo: '~/unbound' } }, bot: bot(directory) });

describe('loadAppConfig', () => {
	it.effect('fills defaults, expands ~ and reads the old stuckAfterSeconds key', () =>
		Effect.gen(function* () {
			const config = yield* load(fullEnv, { config: (directory) => ({ stuckAfterSeconds: 240, teams: { Telecord: { repo: '~/telecord' } }, bot: bot(directory) }), key, appKey });

			assert.strictEqual(config.pollSeconds, 30);
			assert.strictEqual(config.maxInFlight, 1);
			assert.strictEqual(config.awaitingInputAfterSeconds, 240);
			assert.strictEqual(config.flagTransientAfterSeconds, 600);
			assert.strictEqual(config.states.ready, 'Ready For Agent');
			assert.strictEqual(config.labels.stuck, 'agent-stuck');
			assert.strictEqual(config.worktreesDirectory, join(homedir(), '.herdr/worktrees'));
			assert.deepStrictEqual(config.teams, { Telecord: { repo: join(homedir(), 'telecord') } });
			assert.deepStrictEqual({ ...config.bot, app: { id: config.bot.app.id } }, {
				login: 'orchestratorbot',
				ghConfigDirectory: join(homedir(), '.config/gh-orchestratorbot'),
				app: { id: 424242 },
				allowedUsers: ['marioparaschiv'],
			});
			assert.isFalse('stuckAfterSeconds' in config);
			assert.strictEqual(config.env.claudeConfigPath, join(homedir(), '.claude.json'));
			assert.strictEqual(config.env.stateDirectory, '/state');
			assert.strictEqual(Redacted.value(config.linearApiKey), 'lin_api_secret');
			assert.strictEqual(config.appPrivateKey.export({ type: 'pkcs8', format: 'pem' }), appPem);
		}),
	);

	it.effect('reports an env error and two config file errors together in one message', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const error = yield* load(env, { config: (directory) => ({ pollSeconds: 2, maxInflight: 3, ...unbound(directory) }), key, appKey }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 3);
			assert.match(error.message, /HERDR_BIN_PATH/);
			assert.match(error.message, /config\.json pollSeconds: Expected a value greater than or equal to 5/);
			assert.match(error.message, /config\.json maxInflight: Expected no excess property/);
		}),
	);

	it.effect('reports a missing config file and an unsafe key file', () =>
		Effect.gen(function* () {
			const error = yield* load(fullEnv, { key: { text: 'secret', mode: 0o644 }, appKey }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 2);
			assert.match(error.problems[0], /config\.json/);
			assert.match(error.problems[1], /readable by other users; run chmod 600/);
		}),
	);

	it.effect('rejects an empty team map, an unknown team key, a missing or incomplete bot, no allowed users and invalid JSON', () =>
		Effect.gen(function* () {
			const noTeams = yield* load(fullEnv, { config: (directory) => ({ teams: {}, bot: bot(directory) }), key, appKey }).pipe(Effect.flip);
			const unknownKey = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound', repos: '~/x' } }, bot: bot(directory) }), key, appKey }).pipe(Effect.flip);
			const noBot = yield* load(fullEnv, { config: () => ({ teams: { Unbound: { repo: '~/unbound' } } }), key, appKey }).pipe(Effect.flip);
			const noBotLogin = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, bot: { ...bot(directory), login: '' } }), key, appKey }).pipe(Effect.flip);
			const noAllowedUsers = yield* load(fullEnv, {
				config: (directory) => {
					const { allowedUsers: _, ...withoutAllowedUsers } = bot(directory);

					return { teams: { Unbound: { repo: '~/unbound' } }, bot: withoutAllowedUsers };
				},
				key,
				appKey,
			}).pipe(Effect.flip);
			const emptyAllowedUsers = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, bot: { ...bot(directory), allowedUsers: [] } }), key, appKey }).pipe(
				Effect.flip,
			);
			const badJson = yield* load(fullEnv, { config: () => '{ "teams": ', key, appKey }).pipe(Effect.flip);

			assert.match(noTeams.message, /no teams configured/);
			assert.match(unknownKey.message, /repos/);
			assert.match(noBot.message, /config\.json bot: Missing key/);
			assert.match(noBotLogin.message, /config\.json bot\.login: /);
			assert.match(noAllowedUsers.message, /config\.json bot\.allowedUsers: Missing key/);
			assert.match(emptyAllowedUsers.message, /config\.json bot\.allowedUsers: no allowed users configured/);
			assert.match(badJson.message, /config\.json/);
		}),
	);

	it.effect('reports a missing API key file', () =>
		Effect.gen(function* () {
			const error = yield* load(fullEnv, { config: unbound, appKey }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 1);
			assert.match(error.problems[0], /no Linear API key: create .*linear-key with mode 600/);
		}),
	);

	it.effect('reports a missing bot.app field and a missing, loose or unparsable App key file together with the other problems', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const noAppId = yield* load(fullEnv, { config: (directory) => ({ ...unbound(directory), bot: { ...bot(directory), app: { privateKeyFile: join(directory, 'app.pem') } } }), key, appKey }).pipe(
				Effect.flip,
			);
			const noKeyFile = yield* load(env, { config: unbound, key }).pipe(Effect.flip);
			const looseKeyFile = yield* load(fullEnv, { config: unbound, key: { text: 'secret', mode: 0o640 }, appKey: { text: appPem, mode: 0o640 } }).pipe(Effect.flip);
			const notAKey = yield* load(fullEnv, { config: unbound, key, appKey: { text: 'not a key', mode: 0o600 } }).pipe(Effect.flip);

			assert.deepStrictEqual(noAppId.problems.map((problem) => problem.replace(/^\S+config\.json /, '')), ['bot.app.id: Missing key']);
			assert.lengthOf(noKeyFile.problems, 2);
			assert.match(noKeyFile.problems[0], /HERDR_BIN_PATH/);
			assert.match(noKeyFile.problems[1], /^no GitHub App private key: create \S+\/app\.pem with mode 600$/);
			assert.lengthOf(looseKeyFile.problems, 2);
			assert.match(looseKeyFile.problems[0], /linear-key is readable by other users; run chmod 600 /);
			assert.match(looseKeyFile.problems[1], /app\.pem is readable by other users; run chmod 600 \S+\/app\.pem$/);
			assert.match(notAKey.problems[0], /app\.pem is not a PEM private key$/);
		}),
	);
});
