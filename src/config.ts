import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { Config, Context, Effect, FileSystem, Layer, Predicate, Redacted, Result, Schema, SchemaGetter, SchemaIssue } from 'effect';

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

// Without a trailing slash, so a path compares equal to the paths git and herdr report.
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
	// The backstop poll. Linear webhook deliveries and herdr events trigger the ticks that matter in between.
	pollSeconds: IntAtLeast(5, 600),
	maxInFlight: IntAtLeast(1, 1),
	// How old an epic must be before it is claimed. An epic is often created before its sub-issues, and a claim in
	// between starts it inline.
	dispatchSettleSeconds: IntAtLeast(0, 60),
	// How long an agent may sit idle or blocked without a PR before the epic is flagged as awaiting input.
	awaitingInputAfterSeconds: IntAtLeast(30, 180),
	// How long a dispatched run may take to confirm Claude started before it is flagged as an error. Starts run
	// one at a time, so this covers waiting behind other starts as well as the fetch and herdr's 30 s start wait.
	startTimeoutSeconds: IntAtLeast(60, 300),
	// How long herdr may report working while the pane tail stays the same before the agent is nudged.
	staleAfterSeconds: IntAtLeast(60, 600),
	// How long after the nudge the tail may stay the same before the epic is flagged as stale.
	nudgeGraceSeconds: IntAtLeast(60, 600),
	// How long a run may go, in any state, before the epic is flagged once.
	maxRunSeconds: IntAtLeast(600, 5400),
	// How much context a run's agent or one of its subagents may use before it hands its work to a fresh session.
	handoffAtTokens: IntAtLeast(10_000, 250_000),
	// How much context the main chat's manager may use before it is replaced by a fresh session that starts from its summary.
	managerRotateAtTokens: IntAtLeast(10_000, 50_000),
	// How long an epic may keep failing with transient errors before it is flagged once.
	flagTransientAfterSeconds: IntAtLeast(60, 600),
	// How often the App's failed webhook deliveries are looked for and redelivered.
	deliveryScanSeconds: IntAtLeast(60, 300),
	worktreesDirectory: Path.pipe(withDefault('~/.herdr/worktrees')),
	workspaceLabel: Name('agents'),
	states: Schema.Struct({
		ready: Name('Ready For Agent'),
		implementing: Name('Implementing'),
		inReview: Name('In Review'),
		toReview: Name('To Review'),
		shipped: Name('Shipped'),
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
	// The Telegram bot the user talks to in a private chat, logged in over MTProto with an app's api_id and api_hash
	// (my.telegram.org). Messages from anyone but `allowedUserIds` are dropped.
	telegram: Schema.Struct({
		botTokenFile: Path,
		apiIdFile: Path,
		apiHashFile: Path,
		allowedUserIds: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))).check(Schema.makeFilter((ids) => ids.length > 0 || 'no allowed users configured')),
		// Where the voice note model is; defaults to `<state directory>/models/<transcriptionModel>`.
		transcriptionModelDirectory: Schema.optionalKey(Path),
	}),
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

const env = {
	herdrBinPath: Config.NonEmptyString('HERDR_BIN_PATH'),
	herdrSocketPath: Config.NonEmptyString('HERDR_SOCKET_PATH'),
	configDirectory: Config.NonEmptyString('HERDR_PLUGIN_CONFIG_DIR'),
	stateDirectory: Config.NonEmptyString('HERDR_PLUGIN_STATE_DIR'),
	linearKeyFile: Config.NonEmptyString('SAPPHIRE_AGENT_LINEAR_KEY_FILE').pipe(Config.withDefault(join(homedir(), '.config/sapphire-agent/linear-key'))),
	claudeConfigPath: Config.NonEmptyString('CLAUDE_CONFIG_PATH').pipe(Config.withDefault(join(homedir(), '.claude.json'))),
	claudeConfigDirectory: Config.NonEmptyString('CLAUDE_CONFIG_DIR').pipe(Config.withDefault(join(homedir(), '.claude'))),
};

export type Env = { readonly [K in keyof typeof env]: Config.Success<(typeof env)[K]> };

export const transcriptionModel = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

export const transcriptionModelFiles = { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' } as const;

export type AppConfigShape = Settings & {
	readonly env: Env;
	readonly linearApiKey: Redacted.Redacted<string>;
	readonly appPrivateKey: KeyObject;
	readonly webhookSecret: Redacted.Redacted<string>;
	readonly linearWebhookSecret: Redacted.Redacted<string>;
};

// Only the service talks to Telegram and transcribes voice notes; the CLI runs without these.
export type TelegramConfigShape = {
	readonly botToken: Redacted.Redacted<string>;
	readonly apiId: number;
	readonly apiHash: Redacted.Redacted<string>;
	readonly transcriptionModelDirectory: string;
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

const readTelegramBotToken = (path: string) => readSecretFile(path, 'Telegram bot token').pipe(Effect.map(Redacted.make));

const readTelegramApiId = (path: string) =>
	readSecretFile(path, 'Telegram api_id').pipe(
		Effect.flatMap((text) => Schema.decodeEffect(Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int)))(text).pipe(Effect.mapError(() => [`${path} is not a number`]))),
	);

const readTelegramApiHash = (path: string) => readSecretFile(path, 'Telegram api_hash').pipe(Effect.map(Redacted.make));

const readPrivateKey = (path: string) =>
	readSecretFile(path, 'GitHub App private key').pipe(
		Effect.flatMap((pem) => Effect.try({ try: () => createPrivateKey(pem), catch: () => [`${path} is not a PEM private key`] })),
	);

const resolveTranscriptionModelDirectory = (settings: Settings, stateDirectory: string) =>
	settings.telegram.transcriptionModelDirectory ?? join(stateDirectory, 'models', transcriptionModel);

const checkTranscriptionModel = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = Object.values(transcriptionModelFiles);
		const present = yield* Effect.forEach(files, (file) => fs.exists(join(directory, file)), { concurrency: 'unbounded' });
		const missing = files.filter((_, index) => !present[index]);

		if (missing.length > 0) {
			return yield* Effect.fail([`no transcription model in ${directory}: ${missing.join(', ')} missing; download ${transcriptionModel} there`]);
		}

		return directory;
	}).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail([`${directory}: ${error.message}`])));

const configProblems = (error: Config.ConfigError) => (Schema.isSchemaError(error.cause) ? schemaProblems('', error.cause) : [error.message]);

// A file whose path comes from a failed env var is not read; that env var is already reported.
const readWhen = <P, A>(path: Result.Result<P, unknown>, read: (path: P) => Effect.Effect<A, ReadonlyArray<string>, FileSystem.FileSystem>) =>
	Result.isSuccess(path) ? Effect.result(read(path.success)) : Effect.succeed(Result.fail([]));

const problemsOf = (result: Result.Result<unknown, ReadonlyArray<string>>) => (Result.isFailure(result) ? result.failure : []);

// Reads env, the config file, the Linear API key and webhook secret and the GitHub App's private key and webhook
// secret. Returns the config file and the state directory too, so the Telegram config is read from them in the same pass.
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

	return { settings, stateDirectory: envResults.stateDirectory, config };
});

// Reads the Telegram bot token, api_id and api_hash and checks the transcription model is there.
const readTelegramConfig = (settings: Result.Result<Settings, unknown>, stateDirectory: Result.Result<string, unknown>) =>
	Effect.gen(function* () {
		const botToken = yield* readWhen(Result.map(settings, ({ telegram }) => telegram.botTokenFile), readTelegramBotToken);
		const apiId = yield* readWhen(Result.map(settings, ({ telegram }) => telegram.apiIdFile), readTelegramApiId);
		const apiHash = yield* readWhen(Result.map(settings, ({ telegram }) => telegram.apiHashFile), readTelegramApiHash);
		const transcriptionModelDirectory = yield* readWhen(
			Result.all({ settings, stateDirectory }).pipe(Result.map(({ settings, stateDirectory }) => resolveTranscriptionModelDirectory(settings, stateDirectory))),
			checkTranscriptionModel,
		);
		const problems = [...problemsOf(botToken), ...problemsOf(apiId), ...problemsOf(apiHash), ...problemsOf(transcriptionModelDirectory)];
		const loaded = Result.all({ botToken, apiId, apiHash, transcriptionModelDirectory });

		return problems.length > 0 || Result.isFailure(loaded) ? Result.fail(problems) : Result.succeed<TelegramConfigShape>(loaded.success);
	});

const orStartupError = <A>(result: Result.Result<A, ReadonlyArray<string>>) =>
	Result.isFailure(result) ? Effect.fail(new StartupError({ problems: result.failure })) : Effect.succeed(result.success);

// What the CLI needs, every problem in one StartupError.
export const loadAppConfig: Effect.Effect<AppConfigShape, StartupError, FileSystem.FileSystem> = readAppConfig.pipe(Effect.flatMap(({ config }) => orStartupError(config)));

// What the service needs, the Telegram config included, every problem in one StartupError.
export const loadServiceConfig = Effect.gen(function* () {
	const { settings, stateDirectory, config } = yield* readAppConfig;
	const telegram = yield* readTelegramConfig(settings, stateDirectory);

	return yield* orStartupError(Result.all({ app: config, telegram }).pipe(Result.mapError(() => [...problemsOf(config), ...problemsOf(telegram)])));
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()('sapphire-agent/AppConfig') {
	static readonly layer = Layer.effect(AppConfig, loadAppConfig);

	// Defaults plus one team, the bot and the Telegram bot, with every path under `directory`, a freshly generated App key
	// and the webhook server on a free port.
	static readonly layerTest = (directory: string, settings: Partial<typeof Settings.Encoded> = {}) =>
		Layer.sync(AppConfig, () => ({
			...Schema.decodeUnknownSync(Settings)({
				teams: { Test: { repo: join(directory, 'repo') } },
				worktreesDirectory: join(directory, 'worktrees'),
				linearWebhookSecretFile: join(directory, 'linear-webhook-secret'),
				bot: {
					login: 'orchestratorbot',
					app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret'), webhookPort: 0 },
					allowedUsers: ['marioparaschiv'],
				},
				telegram: {
					botTokenFile: join(directory, 'telegram-bot-token'),
					apiIdFile: join(directory, 'telegram-api-id'),
					apiHashFile: join(directory, 'telegram-api-hash'),
					allowedUserIds: [7_100_200_300],
				},
				...settings,
			}),
			env: {
				herdrBinPath: 'herdr',
				herdrSocketPath: join(directory, 'herdr.sock'),
				configDirectory: directory,
				stateDirectory: directory,
				linearKeyFile: join(directory, 'linear-key'),
				claudeConfigPath: join(directory, 'claude.json'),
				claudeConfigDirectory: join(directory, 'claude'),
			},
			linearApiKey: Redacted.make('lin_api_test'),
			appPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
			webhookSecret: Redacted.make('test-webhook-secret'),
			linearWebhookSecret: Redacted.make('test-linear-webhook-secret'),
		}));
}

export class TelegramConfig extends Context.Service<TelegramConfig, TelegramConfigShape>()('sapphire-agent/TelegramConfig') {
	// AppConfig and TelegramConfig, read in one pass.
	static readonly layerWithAppConfig = Layer.effectContext(
		loadServiceConfig.pipe(Effect.map(({ app, telegram }) => Context.make(AppConfig, app).pipe(Context.add(TelegramConfig, telegram)))),
	);

	// The model in `<directory>/models/<transcriptionModel>`, as AppConfig.layerTest's state directory has it.
	static readonly layerTest = (directory: string) =>
		Layer.succeed(TelegramConfig, {
			botToken: Redacted.make('123456:test-bot-token'),
			apiId: 1_234_567,
			apiHash: Redacted.make('test-api-hash'),
			transcriptionModelDirectory: join(directory, 'models', transcriptionModel),
		});
}
