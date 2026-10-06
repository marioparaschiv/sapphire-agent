import { join } from 'node:path';
import { Duration, Effect, FileSystem, Option, Schema } from 'effect';
import { AppConfig } from './config.ts';

// What `claude -p --output-format stream-json --verbose` says it runs with, before it calls the model.
export const InitEvent = Schema.Struct({
	type: Schema.Literal('system'),
	subtype: Schema.Literal('init'),
	model: Schema.String,
	permissionMode: Schema.String,
	output_style: Schema.String,
	// `source` is the key of enabledPlugins, e.g. `frontend-design@claude-plugins-official`.
	plugins: Schema.Array(Schema.Struct({ source: Schema.String })),
	mcp_servers: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
});

export type InitEvent = typeof InitEvent.Type;

// The keys of ~/.claude/settings.json the init event shows; every other key is left as it is.
export const ClaudeSettings = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	outputStyle: Schema.optionalKey(Schema.String),
	permissions: Schema.optionalKey(Schema.Struct({ defaultMode: Schema.optionalKey(Schema.String) })),
	enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});

export type ClaudeSettings = typeof ClaudeSettings.Type;

// How long a session's prompt cache lives after its last use. Unset, Claude picks it by account, so nothing is assumed.
const PromptCacheSettings = Schema.Struct({ promptCacheTtl: Schema.optionalKey(Schema.Literals(['5m', '1h'])) });

const cacheLifetimes = { '5m': Duration.minutes(5), '1h': Duration.hours(1) };

// A session is warmed or reminded about this long before its cache expires.
export const cacheExpiryNotice = Duration.minutes(5);

// The user's MCP servers live in ~/.claude.json, not settings.json.
const ClaudeConfig = Schema.Struct({ mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) });

export type SettingsMismatch = { readonly key: string; readonly configured: string; readonly reported: string };

// `opus[1m]` is the model `opus` with the context `[1m]`.
const splitContext = (model: string) => {
	const index = model.indexOf('[');

	return index === -1 ? [model, ''] : [model.slice(0, index), model.slice(index)];
};

// settings.json may name the model by its alias (`opus[1m]`), which init reports resolved (`claude-opus-5-5[1m]`).
export const modelMatches = (configured: string, reported: string) => {
	const [configuredModel, configuredContext] = splitContext(configured);
	const [reportedModel, reportedContext] = splitContext(reported);

	return configuredContext === reportedContext && (configuredModel === reportedModel || reportedModel.startsWith(`claude-${configuredModel}-`));
};

// Each configured setting a chat turn does not run with.
export const settingsMismatches = (settings: ClaudeSettings, mcpServers: ReadonlyArray<string>, init: InitEvent): ReadonlyArray<SettingsMismatch> => {
	const mismatches: Array<SettingsMismatch> = [];
	const defaultMode = settings.permissions?.defaultMode;

	if (settings.model !== undefined && !modelMatches(settings.model, init.model)) {
		mismatches.push({ key: 'model', configured: settings.model, reported: init.model });
	}

	if (settings.outputStyle !== undefined && settings.outputStyle !== init.output_style) {
		mismatches.push({ key: 'outputStyle', configured: settings.outputStyle, reported: init.output_style });
	}

	if (defaultMode !== undefined && defaultMode !== init.permissionMode) {
		mismatches.push({ key: 'permissions.defaultMode', configured: defaultMode, reported: init.permissionMode });
	}

	for (const [plugin, enabled] of Object.entries(settings.enabledPlugins ?? {})) {
		const loaded = init.plugins.some(({ source }) => source === plugin);

		if (enabled !== loaded) {
			mismatches.push({ key: `enabledPlugins.${plugin}`, configured: enabled ? 'enabled' : 'disabled', reported: loaded ? 'loaded' : 'not loaded' });
		}
	}

	for (const name of mcpServers) {
		const server = init.mcp_servers.find((candidate) => candidate.name === name);

		if (server === undefined || server.status === 'failed') {
			mismatches.push({ key: `mcpServers.${name}`, configured: 'configured', reported: server?.status ?? 'missing' });
		}
	}

	return mismatches;
};

const readSettingsFile = Effect.gen(function* () {
	const { env } = yield* AppConfig;
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(join(env.claudeConfigDirectory, 'settings.json'));
});

// settings.json in the Claude config directory, and the MCP server names of ~/.claude.json.
export const readClaudeSettings = Effect.gen(function* () {
	const { env } = yield* AppConfig;
	const fs = yield* FileSystem.FileSystem;
	const settings = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeSettings))(yield* readSettingsFile);
	const { mcpServers = {} } = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeConfig))(yield* fs.readFileString(env.claudeConfigPath));

	return { settings, mcpServers: Object.keys(mcpServers) };
});

// How long after a session's last turn its prompt cache is about to expire, from settings.json's promptCacheTtl. None
// when the cache lives no longer than the notice, or its lifetime is not set.
export const readCacheRefreshDelay = readSettingsFile.pipe(
	Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PromptCacheSettings))),
	Effect.map(({ promptCacheTtl }) =>
		Option.filter(Option.map(Option.fromUndefinedOr(promptCacheTtl), (ttl) => Duration.subtract(cacheLifetimes[ttl], cacheExpiryNotice)), Duration.isPositive),
	),
);
