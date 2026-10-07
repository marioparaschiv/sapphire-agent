import { Effect, FileSystem, Option, Schema } from 'effect';
import { fileSystemFailure, Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Journal } from './journal.ts';
import { Projects } from './projects.ts';
import { Pushover, sendOrLog } from './pushover.ts';

// What T3 keeps of the two settings cleanup relies on, in its `settings.json`. No MCP tool reads or changes them, so
// they are set by hand in T3 and checked here. Absent keys take T3's defaults.
const CleanupRules = Schema.Struct({
	worktreeAfterDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
	worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
	worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
});

// null: the rules in storageCleanup apply.
const WorktreeCleanup = Schema.NullOr(Schema.Union([Schema.Struct({ mode: Schema.Literal('off') }), Schema.Struct({ mode: Schema.Literal('custom'), rules: CleanupRules })]));

const Overrides = Schema.Struct({ worktreeCleanup: Schema.optionalKey(WorktreeCleanup), sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean) });

const T3SettingsFile = Schema.fromJsonString(
	Schema.Struct({
		...Overrides.fields,
		storageCleanup: Schema.optionalKey(CleanupRules),
		projectSettingsOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Overrides))),
	}),
);

type T3Settings = typeof T3SettingsFile.Type;

// The provider instance and model T3 starts a thread with, as `t3_thread_launch` takes it.
export const ModelSelection = Schema.Struct({
	instanceId: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	options: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, value: Schema.Union([Schema.NonEmptyString, Schema.Boolean]) }))),
});

export type ModelSelection = typeof ModelSelection.Type;

const DefaultModelFile = Schema.fromJsonString(Schema.Struct({ defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)) }));

// None for a missing file.
const readSettingsText = (path: string) =>
	FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
		Effect.map(Option.some),
		Effect.catchTag('PlatformError', (error) => (error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(fileSystemFailure(error)))),
	);

// A project's own value wins over the environment's, a null one included.
const effective = (settings: T3Settings, projectId: string | null) => {
	const own = (projectId === null ? null : settings.projectSettingsOverrides?.[projectId]) ?? {};
	const policy = own.worktreeCleanup !== undefined ? own.worktreeCleanup : (settings.worktreeCleanup ?? null);
	const rules = policy === null ? (settings.storageCleanup ?? {}) : policy.mode === 'custom' ? policy.rules : {};
	const cleansWorktrees = (rules.worktreeAfterDays ?? null) !== null || rules.worktreeOnMerge === true || rules.worktreeOnDelete === true || rules.worktreeUnchanged === true;

	return { cleansWorktrees, autoSettlesMerged: own.sidebarAutoSettleOnMerge ?? settings.sidebarAutoSettleOnMerge ?? true };
};

// What is wrong with T3's settings for the given projects: T3 must not remove their worktrees itself (cleanup removes
// them once every commit is on origin), and must settle threads whose PR merged. A missing file is T3's defaults.
// A repo without a T3 project yet gets the environment's settings once it has one.
export const t3SettingsProblems = (path: string, projects: ReadonlyArray<{ readonly repo: string; readonly projectId: string | null }>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(path).pipe(
			Effect.map(Option.some),
			Effect.catchTag('PlatformError', (error) => (error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(fileSystemFailure(error)))),
		);
		const settings = Option.isNone(text) ? {} : yield* Schema.decodeEffect(T3SettingsFile)(text.value);

		return projects.flatMap(({ repo, projectId }) => {
			const { cleansWorktrees, autoSettlesMerged } = effective(settings, projectId);

			return [
				...(cleansWorktrees ? [`T3 removes the worktrees of ${repo} itself: set its project's Automatic worktree cleanup to Off`] : []),
				...(autoSettlesMerged ? [] : [`T3 does not settle the threads of ${repo} once their PR merged: turn on Auto-settle merged threads`]),
			];
		});
	});

// The environment's default model, the one T3's composer starts new threads with. T3 does not fall back to it for a
// thread launched over MCP in a project without a default model of its own, so every launch passes it.
export const defaultModelSelection = (path: string) =>
	Effect.gen(function* () {
		const missing = (why: string) => new Permanent({ message: `${why}: set a default model in T3` });
		const text = yield* readSettingsText(path);

		if (Option.isNone(text)) {
			return yield* missing(`T3's settings file ${path} does not exist`);
		}

		const { defaultModelSelection } = yield* Schema.decodeEffect(DefaultModelFile)(text.value).pipe(
			Effect.mapError((cause) => new Permanent({ message: `cannot read T3's default model from ${path}: ${cause.message}`, cause })),
		);

		if (defaultModelSelection === undefined || defaultModelSelection === null) {
			return yield* missing(`T3's settings in ${path} have no default model`);
		}

		return defaultModelSelection;
	});

// At startup: Pushover hears once what is wrong with T3's settings for the projects' repos and the label repos T3 has
// a project for. A settings file that cannot be read is only logged; runs go on either way.
export const checkT3Settings = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const projects = yield* Projects;
	const pushover = yield* Pushover;
	const known = yield* journal.listT3Projects;
	const repos = [...new Set([...(yield* projects.list).map(({ repo }) => repo), ...known.map(({ repo }) => repo)])];
	const path = config.t3.settingsFile;
	const problems = yield* t3SettingsProblems(
		path,
		repos.map((repo) => ({ repo, projectId: known.find((row) => row.repo === repo)?.projectId ?? null })),
	).pipe(Effect.catch((error) => Effect.logWarning(`cannot check T3's settings in ${path}`, error).pipe(Effect.as([]))));

	if (problems.length === 0) {
		return;
	}

	yield* Effect.logWarning(`T3's settings in ${path} need a change: ${problems.join('; ')}`);
	yield* sendOrLog(pushover, { title: "T3's settings need a change for sapphire-agent", message: problems.join('\n'), priority: 'normal' });
});
