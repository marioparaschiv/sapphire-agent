import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, Context, Effect, FileSystem, Layer, Predicate, Redacted, Result, Schema, SchemaGetter, SchemaIssue } from 'effect';

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

const Path = Schema.NonEmptyString.pipe(Schema.decode({ decode: SchemaGetter.transform(expandHome), encode: SchemaGetter.passthrough() }));

const withDefault = <S extends Schema.Constraint>(value: S['Encoded']) => Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

const IntAtLeast = (minimum: number, fallback: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum)).pipe(withDefault(fallback));

const Name = (fallback: string) => Schema.NonEmptyString.pipe(withDefault(fallback));

const Team = Schema.Struct({
	repo: Path,
	// An epic labelled `<repoPrefix><name>` runs in `<labelReposDirectory>/<name>` instead of `repo`.
	labelReposDirectory: Schema.optionalKey(Path),
});

const Settings = Schema.Struct({
	pollSeconds: IntAtLeast(5, 30),
	maxInFlight: IntAtLeast(1, 1),
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
	// How long an epic may keep failing with transient errors before it is flagged once.
	flagTransientAfterSeconds: IntAtLeast(60, 600),
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
	teams: Schema.Record(Schema.NonEmptyString, Team).check(Schema.makeFilter((teams) => Object.keys(teams).length > 0 || 'no teams configured')),
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
	linearKeyFile: Config.NonEmptyString('HERDR_LINEAR_KEY_FILE').pipe(Config.withDefault(join(homedir(), '.config/herdr-linear/linear-key'))),
	claudeConfigPath: Config.NonEmptyString('CLAUDE_CONFIG_PATH').pipe(Config.withDefault(join(homedir(), '.claude.json'))),
};

export type Env = { readonly [K in keyof typeof env]: Config.Success<(typeof env)[K]> };

export type AppConfigShape = Settings & { readonly env: Env; readonly linearApiKey: Redacted.Redacted<string> };

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

const readApiKey = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const info = yield* fs.stat(path);

		if (info.mode & 0o077) {
			return yield* Effect.fail([`${path} is readable by other users; run chmod 600 ${path}`]);
		}

		const key = (yield* fs.readFileString(path)).trim();

		if (!key) {
			return yield* Effect.fail([`${path} is empty`]);
		}

		return Redacted.make(key);
	}).pipe(
		Effect.catchTag('PlatformError', (error) =>
			Effect.fail([error.reason._tag === 'NotFound' ? `no Linear API key: create ${path} with mode 600` : `${path}: ${error.message}`]),
		),
	);

const configProblems = (error: Config.ConfigError) => (Schema.isSchemaError(error.cause) ? schemaProblems('', error.cause) : [error.message]);

// A file whose path comes from a failed env var is not read; that env var is already reported.
const readWhen = <P, A>(path: Result.Result<P, unknown>, read: (path: P) => Effect.Effect<A, ReadonlyArray<string>, FileSystem.FileSystem>) =>
	Result.isSuccess(path) ? Effect.result(read(path.success)) : Effect.succeed(Result.fail([]));

const problemsOf = (result: Result.Result<unknown, ReadonlyArray<string>>) => (Result.isFailure(result) ? result.failure : []);

// Reads env, the config file and the Linear API key, and reports every problem in one StartupError.
export const loadAppConfig: Effect.Effect<AppConfigShape, StartupError, FileSystem.FileSystem> = Effect.gen(function* () {
	const envResults = yield* Effect.all(env, { mode: 'result' });
	const settings = yield* readWhen(envResults.configDirectory, (directory) => readSettings(join(directory, 'config.json')));
	const linearApiKey = yield* readWhen(envResults.linearKeyFile, readApiKey);
	const problems = [
		...Object.values(envResults).flatMap((result) => (Result.isFailure(result) ? configProblems(result.failure) : [])),
		...problemsOf(settings),
		...problemsOf(linearApiKey),
	];
	const loaded = Result.all({ env: Result.all(envResults), settings, linearApiKey });

	if (problems.length > 0 || Result.isFailure(loaded)) {
		return yield* new StartupError({ problems });
	}

	return { ...loaded.success.settings, env: loaded.success.env, linearApiKey: loaded.success.linearApiKey };
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()('herdr-linear/AppConfig') {
	static readonly layer = Layer.effect(AppConfig, loadAppConfig);

	// Defaults plus one team, with every path under `directory`.
	static readonly layerTest = (directory: string, settings: Partial<typeof Settings.Encoded> = {}) =>
		Layer.succeed(AppConfig, {
			...Schema.decodeUnknownSync(Settings)({ teams: { Test: { repo: join(directory, 'repo') } }, worktreesDirectory: join(directory, 'worktrees'), ...settings }),
			env: {
				herdrBinPath: 'herdr',
				herdrSocketPath: join(directory, 'herdr.sock'),
				configDirectory: directory,
				stateDirectory: directory,
				linearKeyFile: join(directory, 'linear-key'),
				claudeConfigPath: join(directory, 'claude.json'),
			},
			linearApiKey: Redacted.make('lin_api_test'),
		});
}
