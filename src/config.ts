import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { Config, Context, Effect, FileSystem, Layer, Predicate, Redacted, Result, Schema, SchemaGetter, SchemaIssue } from 'effect';
import { defaultConfigDirectory, defaultStateDirectory } from './directories.ts';

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

// Without a trailing slash, so a path compares equal to the paths git and T3 report.
export const toPath = (path: string) => normalize(expandHome(path)).replace(/(.)\/$/, '$1');

const Path = Schema.NonEmptyString.pipe(Schema.decode({ decode: SchemaGetter.transform(toPath), encode: SchemaGetter.passthrough() }));

const withDefault = <S extends Schema.Constraint>(value: S['Encoded']) => Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

const IntAtLeast = (minimum: number, fallback: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum)).pipe(withDefault(fallback));

const Name = (fallback: string) => Schema.NonEmptyString.pipe(withDefault(fallback));

const Team = Schema.Struct({
	repo: Path,
	// An epic labelled `<repoPrefix><name>` runs in `<labelReposDirectory>/<name>` instead of `repo`.
	labelReposDirectory: Schema.optionalKey(Path),
});

const Settings = Schema.Struct({
	// The backstop poll. Linear deliveries, thread waits and agent events trigger the ticks that matter in between.
	pollSeconds: IntAtLeast(5, 600),
	maxInFlight: IntAtLeast(1, 1),
	// How old an epic must be before it is claimed. An epic is often created before its sub-issues, and a claim in
	// between starts it inline.
	dispatchSettleSeconds: IntAtLeast(0, 60),
	// How long a command's thread may sit stopped without its agent saying it is done before the command fails.
	awaitingInputAfterSeconds: IntAtLeast(30, 180),
	// How long a dispatched run may take to start its T3 thread before it is flagged as an error.
	startTimeoutSeconds: IntAtLeast(60, 300),
	// How long a run's thread may show no progress before the agent is nudged.
	staleAfterSeconds: IntAtLeast(60, 600),
	// How long after the nudge the agent may do nothing before the epic is flagged as stale.
	nudgeGraceSeconds: IntAtLeast(60, 600),
	// How long a run may go, in any state, before the epic is flagged once.
	maxRunSeconds: IntAtLeast(600, 5400),
	// How much context a run's agent or one of its subagents may use before it hands its work to a fresh session.
	handoffAtTokens: IntAtLeast(10_000, 250_000),
	// How long an epic may keep failing with transient errors before it is flagged once.
	flagTransientAfterSeconds: IntAtLeast(60, 600),
	// Edits to a run's epic or sub-issues are told to its agent in one message once none came for this long.
	editDebounceSeconds: IntAtLeast(0, 60),
	// The model that condenses those edits into the message, run with `claude -p`.
	summaryModel: Name('claude-haiku-5-5'),
	// Where T3 creates its worktrees (its own setting), as `<worktreesDirectory>/<repo>/<branch slug>`.
	worktreesDirectory: Path.pipe(withDefault('~/.t3/worktrees')),
	states: Schema.Struct({
		ready: Name('Ready For Agent'),
		implementing: Name('Implementing'),
		inReview: Name('In Review'),
		toReview: Name('To Review'),
		shipped: Name('Shipped'),
		done: Name('Done'),
	}).pipe(withDefault({})),
	labels: Schema.Struct({
		stuck: Name('agent-stuck'),
		repoPrefix: Name('repo:'),
	}).pipe(withDefault({})),
	// The secret Linear signs its webhook deliveries with. They reach the server on 127.0.0.1:bot.app.webhookPort at /linear.
	linearWebhookSecretFile: Path,
	// Imported into the journal's projects while it has none; `sapphire project` manages them from then on.
	teams: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, Team)),
	// The handle whose @mention by one of `allowedUsers` starts a command run. The GitHub App answers, and its webhook
	// deliveries bring the mentions to a server on 127.0.0.1:webhookPort.
	bot: Schema.Struct({
		login: Schema.NonEmptyString,
		app: Schema.Struct({
			id: Schema.Int.check(Schema.isGreaterThan(0)),
			privateKeyFile: Path,
			webhookSecretFile: Path,
			webhookPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })).pipe(withDefault(3790)),
		}),
		allowedUsers: Schema.Array(Schema.NonEmptyString).check(Schema.makeFilter((users) => users.length > 0 || 'no allowed users configured')),
	}),
	// The Pushover application the service's notices about itself are sent with, and the user key they are sent to.
	pushover: Schema.Struct({
		appTokenFile: Path.pipe(withDefault(join(defaultConfigDirectory, 'pushover-app-token'))),
		userKeyFile: Path.pipe(withDefault(join(defaultConfigDirectory, 'pushover-user-key'))),
	}).pipe(withDefault({})),
	// The T3 Code server runs are dispatched to, over its MCP endpoint at `<url>/mcp`, and the full-access token
	// scripts/mint-t3-token.sh writes.
	t3: Schema.Struct({
		url: Schema.NonEmptyString.pipe(withDefault('http://127.0.0.1:3773')),
		tokenFile: Path.pipe(withDefault(join(defaultConfigDirectory, 't3-token'))),
		// T3's own settings, read to check it leaves sapphire-agent's worktrees alone and settles merged threads, and for
		// the default model every thread is launched with.
		settingsFile: Path.pipe(withDefault('~/.t3/userdata/settings.json')),
	}).pipe(withDefault({})),
});

export type Settings = typeof Settings.Type;

export type StateRole = keyof Settings['states'];

// Older versions called awaitingInputAfterSeconds stuckAfterSeconds.
const renameStuckAfterSeconds = (config: unknown) => {
	if (!Predicate.isObject(config) || !('stuckAfterSeconds' in config)) {
		return config;
	}

	const { stuckAfterSeconds, ...rest } = config;

	return { awaitingInputAfterSeconds: stuckAfterSeconds, ...rest };
};

const SettingsFile = Schema.fromJsonString(
	Schema.Unknown.pipe(
		Schema.decode({ decode: SchemaGetter.transform(renameStuckAfterSeconds), encode: SchemaGetter.passthrough() }),
		Schema.decodeTo(Settings),
	),
);

export const env = {
	configDirectory: Config.NonEmptyString('SAPPHIRE_AGENT_CONFIG_DIR').pipe(Config.withDefault(defaultConfigDirectory)),
	stateDirectory: Config.NonEmptyString('SAPPHIRE_AGENT_STATE_DIR').pipe(Config.withDefault(defaultStateDirectory)),
	linearKeyFile: Config.NonEmptyString('SAPPHIRE_AGENT_LINEAR_KEY_FILE').pipe(Config.withDefault(join(defaultConfigDirectory, 'linear-key'))),
	claudeConfigDirectory: Config.NonEmptyString('CLAUDE_CONFIG_DIR').pipe(Config.withDefault(join(homedir(), '.claude'))),
};

export type Env = { readonly [K in keyof typeof env]: Config.Success<(typeof env)[K]> };

export type AppConfigShape = Settings & {
	readonly env: Env;
	readonly linearApiKey: Redacted.Redacted<string>;
	readonly appPrivateKey: KeyObject;
	readonly webhookSecret: Redacted.Redacted<string>;
	readonly linearWebhookSecret: Redacted.Redacted<string>;
};

// Only the service sends Pushover notices; the CLI runs without these.
type PushoverConfigShape = {
	readonly appToken: Redacted.Redacted<string>;
	readonly userKey: Redacted.Redacted<string>;
};

type T3ConfigShape = {
	readonly url: string;
	readonly token: Redacted.Redacted<string>;
	// Epoch milliseconds, from the token's `exp` claim.
	readonly expiresAt: number;
	// T3's own settings.json, where its default model is.
	readonly settingsFile: string;
};

export class StartupError extends Schema.TaggedError<StartupError>()('StartupError', { problems: Schema.Array(Schema.String) }) {
	override get message() {
		return `cannot start, fix these and restart:\n${this.problems.map((problem) => `- ${problem}`).join('\n')}`;
	}
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

// One problem per issue, e.g. `/x/config.json pollSeconds: Expected a value greater than or equal to 5`.
const schemaProblems = (source: string, error: Schema.SchemaError) =>
	formatIssues(error.issue).issues.map(({ path = [], message }) => {
		const where = [source, path.map((segment) => String(Predicate.isObject(segment) ? segment.key : segment)).join('.')].filter(Boolean).join(' ');

		return `${where}: ${message}`;
	});

const readSettings = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(path);

		return yield* Schema.decodeEffect(SettingsFile)(text, { errors: 'all', onExcessProperty: 'error' });
	}).pipe(
		Effect.catchTags({
			PlatformError: (error) => Effect.fail([`${path}: ${error.message}`]),
			SchemaError: (error) => Effect.fail(schemaProblems(path, error)),
		}),
	);

// The trimmed contents of a file only its owner may read.
const readSecretFile = (path: string, what: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const info = yield* fs.stat(path);

		if (info.mode & 0o077) {
			return yield* Effect.fail([`${path} is readable by other users; run chmod 600 ${path}`]);
		}

		const contents = (yield* fs.readFileString(path)).trim();

		if (!contents) {
			return yield* Effect.fail([`${path} is empty`]);
		}

		return contents;
	}).pipe(
		Effect.catchTag('PlatformError', (error) =>
			Effect.fail([error.reason._tag === 'NotFound' ? `no ${what}: create ${path} with mode 600` : `${path}: ${error.message}`]),
		),
	);

const readApiKey = (path: string) => readSecretFile(path, 'Linear API key').pipe(Effect.map(Redacted.make));

const readWebhookSecret = (path: string) => readSecretFile(path, 'GitHub App webhook secret').pipe(Effect.map(Redacted.make));

const readLinearWebhookSecret = (path: string) => readSecretFile(path, 'Linear webhook secret').pipe(Effect.map(Redacted.make));

// Pushover's app tokens and user keys are 30 letters and digits.
const pushoverKey = /^[A-Za-z0-9]{30}$/;

const readPushoverKey = (path: string, what: string) =>
	readSecretFile(path, what).pipe(
		Effect.flatMap((text) => (pushoverKey.test(text) ? Effect.succeed(Redacted.make(text)) : Effect.fail([`${path} is not a ${what}: expected 30 letters and digits`]))),
	);

// A T3 session token is `<base64url JSON claims>.<signature>`.
const T3TokenClaims = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ exp: Schema.Int }))));

const readT3Token = (path: string) =>
	readSecretFile(path, 'T3 token').pipe(
		Effect.flatMap((token) =>
			Schema.decodeUnknownEffect(T3TokenClaims)(token.split('.')[0]).pipe(
				Effect.map(({ exp }) => ({ token: Redacted.make(token), expiresAt: exp })),
				Effect.mapError(() => [`${path} is not a T3 session token; run scripts/mint-t3-token.sh`]),
			),
		),
	);

const readPrivateKey = (path: string) =>
	readSecretFile(path, 'GitHub App private key').pipe(
		Effect.flatMap((pem) => Effect.try({ try: () => createPrivateKey(pem), catch: () => [`${path} is not a PEM private key`] })),
	);

const configProblems = (error: Config.ConfigError) => (Schema.isSchemaError(error.cause) ? schemaProblems('', error.cause) : [error.message]);

// A file whose path comes from a failed env var is not read; that env var is already reported.
const readWhen = <P, A>(path: Result.Result<P, unknown>, read: (path: P) => Effect.Effect<A, ReadonlyArray<string>, FileSystem.FileSystem>) =>
	Result.isSuccess(path) ? Effect.result(read(path.success)) : Effect.succeed(Result.fail([]));

const problemsOf = (result: Result.Result<unknown, ReadonlyArray<string>>) => (Result.isFailure(result) ? result.failure : []);

// Reads env, the config file, the Linear API key and webhook secret and the GitHub App's private key and webhook
// secret. Returns the config file too, so the Pushover config is read from it in the same pass.
const readAppConfig = Effect.gen(function* () {
	const envResults = yield* Effect.all(env, { mode: 'result' });
	const settings = yield* readWhen(envResults.configDirectory, (directory) => readSettings(join(directory, 'config.json')));
	const linearApiKey = yield* readWhen(envResults.linearKeyFile, readApiKey);
	const appPrivateKey = yield* readWhen(Result.map(settings, ({ bot }) => bot.app.privateKeyFile), readPrivateKey);
	const webhookSecret = yield* readWhen(Result.map(settings, ({ bot }) => bot.app.webhookSecretFile), readWebhookSecret);
	const linearWebhookSecret = yield* readWhen(Result.map(settings, ({ linearWebhookSecretFile }) => linearWebhookSecretFile), readLinearWebhookSecret);
	const problems = [
		...Object.values(envResults).flatMap((result) => (Result.isFailure(result) ? configProblems(result.failure) : [])),
		...problemsOf(settings),
		...problemsOf(linearApiKey),
		...problemsOf(appPrivateKey),
		...problemsOf(webhookSecret),
		...problemsOf(linearWebhookSecret),
	];
	const loaded = Result.all({ env: Result.all(envResults), settings, linearApiKey, appPrivateKey, webhookSecret, linearWebhookSecret });
	const config: Result.Result<AppConfigShape, ReadonlyArray<string>> =
		problems.length > 0 || Result.isFailure(loaded)
			? Result.fail(problems)
			: Result.succeed({
					...loaded.success.settings,
					env: loaded.success.env,
					linearApiKey: loaded.success.linearApiKey,
					appPrivateKey: loaded.success.appPrivateKey,
					webhookSecret: loaded.success.webhookSecret,
					linearWebhookSecret: loaded.success.linearWebhookSecret,
				});

	return { settings, config };
});

// Reads the Pushover app token and user key.
const readPushoverConfig = (settings: Result.Result<Settings, unknown>) =>
	Effect.gen(function* () {
		const appToken = yield* readWhen(Result.map(settings, ({ pushover }) => pushover.appTokenFile), (path) => readPushoverKey(path, 'Pushover app token'));
		const userKey = yield* readWhen(Result.map(settings, ({ pushover }) => pushover.userKeyFile), (path) => readPushoverKey(path, 'Pushover user key'));
		const problems = [...problemsOf(appToken), ...problemsOf(userKey)];
		const loaded = Result.all({ appToken, userKey });

		return problems.length > 0 || Result.isFailure(loaded) ? Result.fail(problems) : Result.succeed<PushoverConfigShape>(loaded.success);
	});

// The config file alone, for the agent hook, which decides its guards without the secrets.
export const loadSettings = Effect.gen(function* () {
	const directory = yield* env.configDirectory.pipe(Effect.mapError(configProblems));

	return yield* readSettings(join(directory, 'config.json'));
}).pipe(Effect.mapError((problems) => new StartupError({ problems })));

const orStartupError = <A>(result: Result.Result<A, ReadonlyArray<string>>) =>
	Result.isFailure(result) ? Effect.fail(new StartupError({ problems: result.failure })) : Effect.succeed(result.success);

// What the CLI needs, every problem in one StartupError.
export const loadAppConfig: Effect.Effect<AppConfigShape, StartupError, FileSystem.FileSystem> = readAppConfig.pipe(Effect.flatMap(({ config }) => orStartupError(config)));

// What the service needs, the Pushover config included, every problem in one StartupError.
export const loadServiceConfig = Effect.gen(function* () {
	const { settings, config } = yield* readAppConfig;
	const pushover = yield* readPushoverConfig(settings);

	return yield* orStartupError(Result.all({ app: config, pushover }).pipe(Result.mapError(() => [...problemsOf(config), ...problemsOf(pushover)])));
});

// The config file of AppConfig.layerTest.
export const testSettings = (directory: string, settings: Partial<typeof Settings.Encoded> = {}): typeof Settings.Encoded => ({
	teams: { Test: { repo: join(directory, 'repo') } },
	worktreesDirectory: join(directory, 'worktrees'),
	linearWebhookSecretFile: join(directory, 'linear-webhook-secret'),
	bot: {
		login: 'orchestratorbot',
		app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret'), webhookPort: 0 },
		allowedUsers: ['marioparaschiv'],
	},
	pushover: { appTokenFile: join(directory, 'pushover-app-token'), userKeyFile: join(directory, 'pushover-user-key') },
	t3: { settingsFile: join(directory, 't3-settings.json') },
	...settings,
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()('sapphire-agent/AppConfig') {
	static readonly layer = Layer.effect(AppConfig, loadAppConfig);

	// Defaults plus one team and the bot, with every path under `directory`, a freshly generated App key
	// and the webhook server on a free port.
	static readonly layerTest = (directory: string, settings: Partial<typeof Settings.Encoded> = {}) =>
		Layer.sync(AppConfig, () => ({
			...Schema.decodeUnknownSync(Settings)(testSettings(directory, settings)),
			env: {
				configDirectory: directory,
				stateDirectory: directory,
				linearKeyFile: join(directory, 'linear-key'),
				claudeConfigDirectory: join(directory, 'claude'),
			},
			linearApiKey: Redacted.make('lin_api_test'),
			appPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
			webhookSecret: Redacted.make('test-webhook-secret'),
			linearWebhookSecret: Redacted.make('test-linear-webhook-secret'),
		}));
}

export class PushoverConfig extends Context.Service<PushoverConfig, PushoverConfigShape>()('sapphire-agent/PushoverConfig') {
	// AppConfig and PushoverConfig, read in one pass.
	static readonly layerWithAppConfig = Layer.effectContext(
		loadServiceConfig.pipe(Effect.map(({ app, pushover }) => Context.make(AppConfig, app).pipe(Context.add(PushoverConfig, pushover)))),
	);
}

export class T3Config extends Context.Service<T3Config, T3ConfigShape>()('sapphire-agent/T3Config') {
	static readonly layer = Layer.effect(
		T3Config,
		Effect.gen(function* () {
			const { t3 } = yield* AppConfig;
			const { token, expiresAt } = yield* readT3Token(t3.tokenFile).pipe(Effect.mapError((problems) => new StartupError({ problems })));

			return { url: t3.url, token, expiresAt, settingsFile: t3.settingsFile };
		}),
	);

	// By default T3's settings as recorded from the live server, which have a default model.
	static readonly layerTest = (settingsFile = join(import.meta.dirname, 'fixtures/t3/settings.json')) =>
		Layer.succeed(T3Config, { url: 'http://127.0.0.1:3773', token: Redacted.make('test-t3-token'), expiresAt: Date.UTC(2036, 9, 4, 12), settingsFile });
}
