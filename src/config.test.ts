import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Redacted } from 'effect';
import { loadAppConfig } from './config.ts';

type SecretFile = { text: string; mode: number };

// `config` gets the temp directory the files are written to. Each Telegram file is written unless given as null.
const load = (
	env: Record<string, string>,
	files: {
		config?: (directory: string) => unknown;
		key?: SecretFile;
		appKey?: SecretFile;
		webhookSecret?: SecretFile;
		linearWebhookSecret?: SecretFile;
		telegramToken?: SecretFile | null;
		telegramApiId?: SecretFile | null;
		telegramApiHash?: SecretFile | null;
	},
) =>
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

		if (files.webhookSecret) {
			yield* fs.writeFileString(join(directory, 'webhook-secret'), files.webhookSecret.text, { mode: files.webhookSecret.mode }).pipe(Effect.orDie);
		}

		if (files.linearWebhookSecret) {
			yield* fs.writeFileString(join(directory, 'linear-webhook-secret'), files.linearWebhookSecret.text, { mode: files.linearWebhookSecret.mode }).pipe(Effect.orDie);
		}

		const telegramFiles = {
			'telegram-bot-token': files.telegramToken === undefined ? { text: '123456:telegram-secret\n', mode: 0o600 } : files.telegramToken,
			'telegram-api-id': files.telegramApiId === undefined ? { text: '1234567\n', mode: 0o600 } : files.telegramApiId,
			'telegram-api-hash': files.telegramApiHash === undefined ? { text: 'telegram-api-hash\n', mode: 0o600 } : files.telegramApiHash,
		};

		for (const [name, file] of Object.entries(telegramFiles)) {
			if (file) {
				yield* fs.writeFileString(join(directory, name), file.text, { mode: file.mode }).pipe(Effect.orDie);
			}
		}

		const provider = ConfigProvider.fromEnvRecord({
			HERDR_PLUGIN_CONFIG_DIR: directory,
			SAPPHIRE_AGENT_LINEAR_KEY_FILE: join(directory, 'linear-key'),
			...env,
		});

		return yield* loadAppConfig.pipe(Effect.provide(ConfigProvider.layer(provider)));
	}).pipe(Effect.provide(NodeFileSystem.layer));

const fullEnv = { HERDR_BIN_PATH: '/bin/herdr', HERDR_SOCKET_PATH: '/run/herdr.sock', HERDR_PLUGIN_STATE_DIR: '/state' };
const key = { text: 'lin_api_secret\n', mode: 0o600 };
const appPem = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
const appKey = { text: appPem, mode: 0o600 };
const webhookSecret = { text: 'whsec_test\n', mode: 0o600 };
const linearWebhookSecret = { text: 'lin_wh_test\n', mode: 0o600 };
const linearWebhookSecretFile = (directory: string) => join(directory, 'linear-webhook-secret');
const bot = (directory: string) => ({
	login: 'orchestratorbot',
	app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') },
	allowedUsers: ['marioparaschiv'],
});
const telegram = (directory: string) => ({
	botTokenFile: join(directory, 'telegram-bot-token'),
	apiIdFile: join(directory, 'telegram-api-id'),
	apiHashFile: join(directory, 'telegram-api-hash'),
	allowedUserIds: [7_100_200_300],
});
const unbound = (directory: string) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), telegram: telegram(directory) });

describe('loadAppConfig', () => {
	it.effect('fills defaults, expands ~ and reads the old stuckAfterSeconds key', () =>
		Effect.gen(function* () {
			const config = yield* load(fullEnv, { config: (directory) => ({ stuckAfterSeconds: 240, teams: { Telecord: { repo: '~/telecord' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret });

			assert.strictEqual(config.pollSeconds, 600);
			assert.strictEqual(config.maxInFlight, 1);
			assert.strictEqual(config.awaitingInputAfterSeconds, 240);
			assert.strictEqual(config.flagTransientAfterSeconds, 600);
			assert.strictEqual(config.states.ready, 'Ready For Agent');
			assert.strictEqual(config.labels.stuck, 'agent-stuck');
			assert.strictEqual(config.worktreesDirectory, join(homedir(), '.herdr/worktrees'));
			assert.deepStrictEqual(config.teams, { Telecord: { repo: join(homedir(), 'telecord') } });
			assert.deepStrictEqual({ ...config.bot, app: { id: config.bot.app.id, webhookPort: config.bot.app.webhookPort } }, {
				login: 'orchestratorbot',
				app: { id: 424242, webhookPort: 3790 },
				allowedUsers: ['marioparaschiv'],
			});
			assert.isFalse('stuckAfterSeconds' in config);
			assert.strictEqual(config.env.claudeConfigPath, join(homedir(), '.claude.json'));
			assert.strictEqual(config.env.claudeConfigDirectory, join(homedir(), '.claude'));
			assert.strictEqual(config.env.stateDirectory, '/state');
			assert.strictEqual(Redacted.value(config.linearApiKey), 'lin_api_secret');
			assert.strictEqual(config.appPrivateKey.export({ type: 'pkcs8', format: 'pem' }), appPem);
			assert.strictEqual(Redacted.value(config.webhookSecret), 'whsec_test');
			assert.strictEqual(Redacted.value(config.linearWebhookSecret), 'lin_wh_test');
			assert.deepStrictEqual(config.telegram.allowedUserIds, [7_100_200_300]);
			assert.strictEqual(Redacted.value(config.telegramBotToken), '123456:telegram-secret');
			assert.strictEqual(config.telegramApiId, 1_234_567);
			assert.strictEqual(Redacted.value(config.telegramApiHash), 'telegram-api-hash');
		}),
	);

	it.effect('reports an env error and two config file errors together in one message', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const error = yield* load(env, { config: (directory) => ({ pollSeconds: 2, maxInflight: 3, ...unbound(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

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
			const noTeams = yield* load(fullEnv, { config: (directory) => ({ teams: {}, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const unknownKey = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound', repos: '~/x' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noBot = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noBotLogin = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: { ...bot(directory), login: '' }, telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noAllowedUsers = yield* load(fullEnv, {
				config: (directory) => {
					const { allowedUsers: _, ...withoutAllowedUsers } = bot(directory);

					return { teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: withoutAllowedUsers, telegram: telegram(directory) };
				},
				key,
				appKey,
				webhookSecret,
				linearWebhookSecret,
			}).pipe(Effect.flip);
			const emptyAllowedUsers = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: { ...bot(directory), allowedUsers: [] }, telegram: telegram(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(
				Effect.flip,
			);
			const badJson = yield* load(fullEnv, { config: () => '{ "teams": ', key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

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
			const error = yield* load(fullEnv, { config: unbound, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 1);
			assert.match(error.problems[0], /no Linear API key: create .*linear-key with mode 600/);
		}),
	);

	it.effect('reports a missing bot.app field and a missing, loose or unparsable App key file together with the other problems', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const noAppId = yield* load(fullEnv, { config: (directory) => ({ ...unbound(directory), bot: { ...bot(directory), app: { privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') } } }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(
				Effect.flip,
			);
			const noKeyFile = yield* load(env, { config: unbound, key, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const looseKeyFile = yield* load(fullEnv, { config: unbound, key: { text: 'secret', mode: 0o640 }, appKey: { text: appPem, mode: 0o640 }, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const notAKey = yield* load(fullEnv, { config: unbound, key, appKey: { text: 'not a key', mode: 0o600 }, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

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

	it.effect('reports a missing or loose webhook secret file together with the other problems', () =>
		Effect.gen(function* () {
			const missing = yield* load(fullEnv, { config: unbound, key: { text: 'secret', mode: 0o644 }, appKey, linearWebhookSecret }).pipe(Effect.flip);
			const loose = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret: { text: 'whsec_test', mode: 0o604 }, linearWebhookSecret }).pipe(Effect.flip);
			const empty = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret: { text: '\n', mode: 0o600 }, linearWebhookSecret }).pipe(Effect.flip);

			assert.lengthOf(missing.problems, 2);
			assert.match(missing.problems[0], /linear-key is readable by other users/);
			assert.match(missing.problems[1], /^no GitHub App webhook secret: create \S+\/webhook-secret with mode 600$/);
			assert.lengthOf(loose.problems, 1);
			assert.match(loose.problems[0], /webhook-secret is readable by other users; run chmod 600 \S+\/webhook-secret$/);
			assert.deepStrictEqual(empty.problems.map((problem) => problem.replace(/^\S+\//, '')), ['webhook-secret is empty']);
		}),
	);

	it.effect('reports a missing linearWebhookSecretFile, and a missing or loose Linear webhook secret file', () =>
		Effect.gen(function* () {
			const noField = yield* load(fullEnv, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, bot: bot(directory), telegram: telegram(directory) }), key, appKey, webhookSecret }).pipe(Effect.flip);
			const missing = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret }).pipe(Effect.flip);
			const loose = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret: { text: 'lin_wh_test', mode: 0o640 } }).pipe(Effect.flip);

			assert.deepStrictEqual(noField.problems.map((problem) => problem.replace(/^\S+config\.json /, '')), ['linearWebhookSecretFile: Missing key']);
			assert.deepStrictEqual(missing.problems.map((problem) => problem.replace(/ \S+\//, ' ')), ['no Linear webhook secret: create linear-webhook-secret with mode 600']);
			assert.lengthOf(loose.problems, 1);
			assert.match(loose.problems[0], /linear-webhook-secret is readable by other users; run chmod 600 \S+\/linear-webhook-secret$/);
		}),
	);

	it.effect('reports a missing, loose or unparsable Telegram bot token, api_id or api_hash file and an empty or missing allowlist together with the other problems', () =>
		Effect.gen(function* () {
			const { HERDR_BIN_PATH: _, ...env } = fullEnv;
			const emptyAllowlist = yield* load(env, { config: (directory) => ({ ...unbound(directory), telegram: { ...telegram(directory), allowedUserIds: [] } }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(
				Effect.flip,
			);
			const loose = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, telegramToken: { text: '123456:telegram-secret', mode: 0o644 } }).pipe(Effect.flip);
			const noAllowlist = yield* load(fullEnv, { config: (directory) => ({ ...unbound(directory), telegram: { botTokenFile: join(directory, 'telegram-bot-token') } }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const missingFiles = yield* load(env, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, telegramToken: null, telegramApiId: null, telegramApiHash: null }).pipe(Effect.flip);
			const badApiId = yield* load(fullEnv, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, telegramApiId: { text: 'abc', mode: 0o600 }, telegramApiHash: { text: 'hash', mode: 0o640 } }).pipe(Effect.flip);

			assert.lengthOf(emptyAllowlist.problems, 2);
			assert.match(emptyAllowlist.problems[0], /HERDR_BIN_PATH/);
			assert.match(emptyAllowlist.problems[1], /config\.json telegram\.allowedUserIds: no allowed users configured$/);
			assert.lengthOf(missingFiles.problems, 4);
			assert.match(missingFiles.problems[0], /HERDR_BIN_PATH/);
			assert.match(missingFiles.problems[1], /^no Telegram bot token: create \S+\/telegram-bot-token with mode 600$/);
			assert.match(missingFiles.problems[2], /^no Telegram api_id: create \S+\/telegram-api-id with mode 600$/);
			assert.match(missingFiles.problems[3], /^no Telegram api_hash: create \S+\/telegram-api-hash with mode 600$/);
			assert.deepStrictEqual(
				badApiId.problems.map((problem) => problem.replace(/\S+\//g, '')),
				['telegram-api-id is not a number', 'telegram-api-hash is readable by other users; run chmod 600 telegram-api-hash'],
			);
			assert.deepStrictEqual(loose.problems.map((problem) => problem.replace(/\S+\//g, '')), ['telegram-bot-token is readable by other users; run chmod 600 telegram-bot-token']);
			assert.match(noAllowlist.message, /config\.json telegram\.allowedUserIds: Missing key/);
		}),
	);
});
