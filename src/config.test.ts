import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem, Layer, Redacted } from 'effect';
import { AppConfig, loadAppConfig, loadServiceConfig, PushoverConfig, type StartupError, T3Config } from './config.ts';
import { t3TokenExpiring } from './t3-fake.ts';

type SecretFile = { text: string; mode: number };

// Runs the loader. `config` gets the temp directory the files are written to, which is also the state directory. Each
// Pushover file is written unless given as null.
const loadWith =
	<A>(loader: Effect.Effect<A, StartupError, FileSystem.FileSystem>) =>
	(
		env: Record<string, string>,
		files: {
			config?: (directory: string) => unknown;
			key?: SecretFile;
			appKey?: SecretFile;
			webhookSecret?: SecretFile;
			linearWebhookSecret?: SecretFile;
			pushoverAppToken?: SecretFile | null;
			pushoverUserKey?: SecretFile | null;
			t3Token?: SecretFile;
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

			if (files.t3Token) {
				yield* fs.writeFileString(join(directory, 't3-token'), files.t3Token.text, { mode: files.t3Token.mode }).pipe(Effect.orDie);
			}

			const pushoverFiles = {
				'pushover-app-token': files.pushoverAppToken === undefined ? { text: `${appToken}\n`, mode: 0o600 } : files.pushoverAppToken,
				'pushover-user-key': files.pushoverUserKey === undefined ? { text: `${userKey}\n`, mode: 0o600 } : files.pushoverUserKey,
			};

			for (const [name, file] of Object.entries(pushoverFiles)) {
				if (file) {
					yield* fs.writeFileString(join(directory, name), file.text, { mode: file.mode }).pipe(Effect.orDie);
				}
			}

			const provider = ConfigProvider.fromEnvRecord({
				SAPPHIRE_AGENT_CONFIG_DIR: directory,
				SAPPHIRE_AGENT_STATE_DIR: directory,
				SAPPHIRE_AGENT_LINEAR_KEY_FILE: join(directory, 'linear-key'),
				...env,
			});

			return yield* loader.pipe(Effect.provide(ConfigProvider.layer(provider)));
		}).pipe(Effect.provide(NodeFileSystem.layer));

const appToken = 'azGDORePK8gMaC0QOYAMyEEuzJnyUi';
const userKey = 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG';

const load = loadWith(loadServiceConfig);

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
const pushover = (directory: string) => ({ appTokenFile: join(directory, 'pushover-app-token'), userKeyFile: join(directory, 'pushover-user-key') });
const unbound = (directory: string) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), pushover: pushover(directory) });

describe('loadAppConfig', () => {
	it.effect('fills defaults, expands ~ and reads the old stuckAfterSeconds key', () =>
		Effect.gen(function* () {
			const { app: config, pushover: pushoverConfig } = yield* load({}, { config: (directory) => ({ stuckAfterSeconds: 240, teams: { Telecord: { repo: '~/telecord' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret });

			assert.strictEqual(config.pollSeconds, 600);
			assert.strictEqual(config.maxInFlight, 1);
			assert.strictEqual(config.awaitingInputAfterSeconds, 240);
			assert.strictEqual(config.flagTransientAfterSeconds, 600);
			assert.strictEqual(config.states.ready, 'Ready For Agent');
			assert.strictEqual(config.labels.stuck, 'agent-stuck');
			assert.strictEqual(config.worktreesDirectory, join(homedir(), '.t3/worktrees'));
			assert.deepStrictEqual(config.teams, { Telecord: { repo: join(homedir(), 'telecord') } });
			assert.deepStrictEqual({ ...config.bot, app: { id: config.bot.app.id, webhookPort: config.bot.app.webhookPort } }, {
				login: 'orchestratorbot',
				app: { id: 424242, webhookPort: 3790 },
				allowedUsers: ['marioparaschiv'],
			});
			assert.isFalse('stuckAfterSeconds' in config);
			assert.strictEqual(config.env.claudeConfigDirectory, join(homedir(), '.claude'));
			assert.strictEqual(Redacted.value(config.linearApiKey), 'lin_api_secret');
			assert.strictEqual(config.appPrivateKey.export({ type: 'pkcs8', format: 'pem' }), appPem);
			assert.strictEqual(Redacted.value(config.webhookSecret), 'whsec_test');
			assert.strictEqual(Redacted.value(config.linearWebhookSecret), 'lin_wh_test');
			assert.strictEqual(Redacted.value(pushoverConfig.appToken), appToken);
			assert.strictEqual(Redacted.value(pushoverConfig.userKey), userKey);
		}),
	);

	it.effect('reports two config file errors together in one message', () =>
		Effect.gen(function* () {
			const error = yield* load({}, { config: (directory) => ({ pollSeconds: 2, maxInflight: 3, ...unbound(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 2);
			assert.match(error.message, /config\.json pollSeconds: Expected a value greater than or equal to 5/);
			assert.match(error.message, /config\.json maxInflight: Expected no excess property/);
		}),
	);

	it.effect('reports a missing config file and an unsafe key file', () =>
		Effect.gen(function* () {
			const error = yield* load({}, { key: { text: 'secret', mode: 0o644 }, appKey }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 2);
			assert.match(error.problems[0], /config\.json/);
			assert.match(error.problems[1], /readable by other users; run chmod 600/);
		}),
	);

	it.effect('loads a config without teams, which the journal holds instead', () =>
		Effect.gen(function* () {
			const { app: config } = yield* load({}, { config: (directory) => ({ linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret });

			assert.isUndefined(config.teams);
		}),
	);

	it.effect('rejects an unknown team key, a missing or incomplete bot, no allowed users and invalid JSON', () =>
		Effect.gen(function* () {
			const unknownKey = yield* load({}, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound', repos: '~/x' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory), pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noBot = yield* load({}, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noBotLogin = yield* load({}, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: { ...bot(directory), login: '' }, pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const noAllowedUsers = yield* load({}, {
				config: (directory) => {
					const { allowedUsers: _, ...withoutAllowedUsers } = bot(directory);

					return { teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: withoutAllowedUsers, pushover: pushover(directory) };
				},
				key,
				appKey,
				webhookSecret,
				linearWebhookSecret,
			}).pipe(Effect.flip);
			const emptyAllowedUsers = yield* load({}, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: { ...bot(directory), allowedUsers: [] }, pushover: pushover(directory) }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(
				Effect.flip,
			);
			const badJson = yield* load({}, { config: () => '{ "teams": ', key, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

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
			const error = yield* load({}, { config: unbound, appKey, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

			assert.lengthOf(error.problems, 1);
			assert.match(error.problems[0], /no Linear API key: create .*linear-key with mode 600/);
		}),
	);

	it.effect('reports a missing bot.app field and a missing, loose or unparsable App key file together with the other problems', () =>
		Effect.gen(function* () {
			const noAppId = yield* load({}, { config: (directory) => ({ ...unbound(directory), bot: { ...bot(directory), app: { privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') } } }), key, appKey, webhookSecret, linearWebhookSecret }).pipe(
				Effect.flip,
			);
			const noKeyFile = yield* load({}, { config: unbound, key, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const looseKeyFile = yield* load({}, { config: unbound, key: { text: 'secret', mode: 0o640 }, appKey: { text: appPem, mode: 0o640 }, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);
			const notAKey = yield* load({}, { config: unbound, key, appKey: { text: 'not a key', mode: 0o600 }, webhookSecret, linearWebhookSecret }).pipe(Effect.flip);

			assert.deepStrictEqual(noAppId.problems.map((problem) => problem.replace(/^\S+config\.json /, '')), ['bot.app.id: Missing key']);
			assert.lengthOf(noKeyFile.problems, 1);
			assert.match(noKeyFile.problems[0], /^no GitHub App private key: create \S+\/app\.pem with mode 600$/);
			assert.lengthOf(looseKeyFile.problems, 2);
			assert.match(looseKeyFile.problems[0], /linear-key is readable by other users; run chmod 600 /);
			assert.match(looseKeyFile.problems[1], /app\.pem is readable by other users; run chmod 600 \S+\/app\.pem$/);
			assert.match(notAKey.problems[0], /app\.pem is not a PEM private key$/);
		}),
	);

	it.effect('reports a missing or loose webhook secret file together with the other problems', () =>
		Effect.gen(function* () {
			const missing = yield* load({}, { config: unbound, key: { text: 'secret', mode: 0o644 }, appKey, linearWebhookSecret }).pipe(Effect.flip);
			const loose = yield* load({}, { config: unbound, key, appKey, webhookSecret: { text: 'whsec_test', mode: 0o604 }, linearWebhookSecret }).pipe(Effect.flip);
			const empty = yield* load({}, { config: unbound, key, appKey, webhookSecret: { text: '\n', mode: 0o600 }, linearWebhookSecret }).pipe(Effect.flip);

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
			const noField = yield* load({}, { config: (directory) => ({ teams: { Unbound: { repo: '~/unbound' } }, bot: bot(directory), pushover: pushover(directory) }), key, appKey, webhookSecret }).pipe(Effect.flip);
			const missing = yield* load({}, { config: unbound, key, appKey, webhookSecret }).pipe(Effect.flip);
			const loose = yield* load({}, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret: { text: 'lin_wh_test', mode: 0o640 } }).pipe(Effect.flip);

			assert.deepStrictEqual(noField.problems.map((problem) => problem.replace(/^\S+config\.json /, '')), ['linearWebhookSecretFile: Missing key']);
			assert.deepStrictEqual(missing.problems.map((problem) => problem.replace(/ \S+\//, ' ')), ['no Linear webhook secret: create linear-webhook-secret with mode 600']);
			assert.lengthOf(loose.problems, 1);
			assert.match(loose.problems[0], /linear-webhook-secret is readable by other users; run chmod 600 \S+\/linear-webhook-secret$/);
		}),
	);

	it.effect('reports a missing, loose or malformed Pushover app token or user key file together with the other problems', () =>
		Effect.gen(function* () {
			const missing = yield* load({}, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, pushoverAppToken: null, pushoverUserKey: null }).pipe(Effect.flip);
			const loose = yield* load({}, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, pushoverUserKey: { text: userKey, mode: 0o644 } }).pipe(Effect.flip);
			const malformed = yield* load({}, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, pushoverAppToken: { text: 'not-a-token', mode: 0o600 } }).pipe(Effect.flip);

			assert.lengthOf(missing.problems, 2);
			assert.match(missing.problems[0], /^no Pushover app token: create \S+\/pushover-app-token with mode 600$/);
			assert.match(missing.problems[1], /^no Pushover user key: create \S+\/pushover-user-key with mode 600$/);
			assert.deepStrictEqual(loose.problems.map((problem) => problem.replace(/\S+\//g, '')), ['pushover-user-key is readable by other users; run chmod 600 pushover-user-key']);
			assert.deepStrictEqual(malformed.problems.map((problem) => problem.replace(/\S+\//g, '')), ['pushover-app-token is not a Pushover app token: expected 30 letters and digits']);
		}),
	);

	it.effect('reads the Pushover files from ~/.config/sapphire-agent unless the config file names others', () =>
		Effect.gen(function* () {
			const config = yield* loadWith(loadAppConfig)({}, {
				config: (directory) => ({ linearWebhookSecretFile: linearWebhookSecretFile(directory), bot: bot(directory) }),
				key,
				appKey,
				webhookSecret,
				linearWebhookSecret,
			});

			assert.deepStrictEqual(config.pushover, {
				appTokenFile: join(homedir(), '.config/sapphire-agent/pushover-app-token'),
				userKeyFile: join(homedir(), '.config/sapphire-agent/pushover-user-key'),
			});
		}),
	);

	it.effect("loads the CLI's config without the Pushover secrets", () =>
		Effect.gen(function* () {
			const config = yield* loadWith(loadAppConfig)({}, { config: unbound, key, appKey, webhookSecret, linearWebhookSecret, pushoverAppToken: null, pushoverUserKey: null });

			assert.deepStrictEqual(config.teams, { Unbound: { repo: join(homedir(), 'unbound') } });
			assert.strictEqual(Redacted.value(config.linearApiKey), 'lin_api_secret');
		}),
	);
});

describe('startup', () => {
	it.effect('reads the config of a service with only T3, Linear, the GitHub App and Pushover set up', () =>
		Effect.gen(function* () {
			const token = t3TokenExpiring(2_106_716_707_498);
			const services = Effect.all([AppConfig, PushoverConfig, T3Config]).pipe(Effect.provide(T3Config.layer.pipe(Layer.provideMerge(PushoverConfig.layerWithAppConfig))));
			const [app, pushoverConfig, t3] = yield* loadWith(services)(
				{},
				{
					config: (directory) => ({ ...unbound(directory), t3: { tokenFile: join(directory, 't3-token') } }),
					key,
					appKey,
					webhookSecret,
					linearWebhookSecret,
					t3Token: { text: `${token}\n`, mode: 0o600 },
				},
			);

			assert.deepStrictEqual(Object.keys(app.env).toSorted(), ['claudeConfigDirectory', 'configDirectory', 'linearKeyFile', 'stateDirectory']);
			assert.strictEqual(app.bot.app.id, 424242);
			assert.strictEqual(Redacted.value(pushoverConfig.userKey), userKey);
			assert.strictEqual(Redacted.value(t3.token), token);
		}),
	);
});

describe('T3Config', () => {
	// The T3 config of a token file with the given contents and mode, or of none.
	const loadT3 = (file: SecretFile | null) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
			const tokenFile = join(directory, 't3-token');

			if (file) {
				yield* fs.writeFileString(tokenFile, file.text, { mode: file.mode }).pipe(Effect.orDie);
			}

			return yield* T3Config.useSync((config) => config).pipe(Effect.provide(T3Config.layer.pipe(Layer.provide(AppConfig.layerTest(directory, { t3: { tokenFile } })))));
		}).pipe(Effect.provide(NodeFileSystem.layer));

	it.effect('reads the token and when it expires from its claims, with T3 on 127.0.0.1:3773 unless the config file says otherwise', () =>
		Effect.gen(function* () {
			const token = t3TokenExpiring(2_106_716_707_498);
			const config = yield* loadT3({ text: `${token}\n`, mode: 0o600 });

			assert.strictEqual(config.url, 'http://127.0.0.1:3773');
			assert.strictEqual(Redacted.value(config.token), token);
			assert.strictEqual(config.expiresAt, 2_106_716_707_498);
		}),
	);

	it.effect('refuses to start without the token file, with a loose one, or with one that is not a T3 session token', () =>
		Effect.gen(function* () {
			const missing = yield* loadT3(null).pipe(Effect.flip);
			const loose = yield* loadT3({ text: t3TokenExpiring(2_106_716_707_498), mode: 0o644 }).pipe(Effect.flip);
			const opaque = yield* loadT3({ text: 'jAx8pWq0Zr3sYb6Vn2Lm', mode: 0o600 }).pipe(Effect.flip);

			assert.deepStrictEqual(
				[missing, loose, opaque].flatMap(({ problems }) => problems.map((problem) => problem.replace(/\S+\//g, ''))),
				['no T3 token: create t3-token with mode 600', 't3-token is readable by other users; run chmod 600 t3-token', 't3-token is not a T3 session token; run mint-t3-token.sh'],
			);
		}),
	);
});
