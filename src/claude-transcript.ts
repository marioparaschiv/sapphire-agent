import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Schema } from 'effect';
import { fileSystemFailure, type Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';

// What the request behind an assistant entry put in the model's context.
const UsageEntry = Schema.fromJsonString(
	Schema.Struct({
		type: Schema.Literal('assistant'),
		message: Schema.Struct({
			usage: Schema.Struct({ inputTokens: Schema.Int, cacheReadInputTokens: Schema.Int, cacheCreationInputTokens: Schema.Int }).pipe(
				Schema.encodeKeys({ inputTokens: 'input_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' }),
			),
		}),
	}),
);

const decodeUsageEntry = Schema.decodeUnknownOption(UsageEntry);
// Claude Code names a project's directory after its path, shortened past 200 characters with a hash of the path appended.
export const maxSlugLength = 200;

export const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export type TranscriptSession = { readonly id: string; readonly cwd: string };

const newline = 0x0a;

const latestContext = (lines: ReadonlyArray<string>): Option.Option<number> => {
	for (const line of lines.toReversed()) {
		const entry = decodeUsageEntry(line);

		if (Option.isSome(entry)) {
			const { usage } = entry.value.message;

			return Option.some(usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens);
		}
	}

	return Option.none();
};

// How far a transcript was read, up to its last complete line, and the context found up to there.
type ReadContext = { readonly offset: number; readonly tokens: Option.Option<number> };

export class ClaudeTranscript extends Context.Service<
	ClaudeTranscript,
	{
		// The context of the session's latest assistant entry, or of its subagent `agentId`'s: its input, cache read and
		// cache creation tokens. None before the first, or without a transcript. Each call reads only what was appended
		// since the call before.
		readonly contextTokens: (session: TranscriptSession, agentId: string | null) => Effect.Effect<Option.Option<number>, Permanent>;
	}
>()('sapphire-agent/ClaudeTranscript') {
	static readonly layer = Layer.effect(
		ClaudeTranscript,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;
			const projects = join(env.claudeConfigDirectory, 'projects');

			const projectDirectory = (cwd: string) =>
				Effect.gen(function* () {
					const slug = projectSlug(cwd);

					if (slug.length <= maxSlugLength) {
						return Option.some(slug);
					}

					return Option.fromUndefinedOr((yield* fs.readDirectory(projects)).find((name) => name.startsWith(`${slug.slice(0, maxSlugLength)}-`)));
				});

			const notFoundAsNone = <A>(effect: Effect.Effect<Option.Option<A>, PlatformError.PlatformError>) =>
				effect.pipe(Effect.catchTag('PlatformError', (error) => (error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(fileSystemFailure(error)))));

			const transcriptPath = (session: TranscriptSession, agentId: string | null) =>
				Effect.map(projectDirectory(session.cwd), (directory) =>
					Option.map(directory, (name) =>
						agentId === null ? join(projects, name, `${session.id}.jsonl`) : join(projects, name, session.id, 'subagents', `agent-${agentId}.jsonl`),
					),
				);

			const appendedSince = (path: string, offset: number) =>
				Effect.gen(function* () {
					const file = yield* fs.open(path);
					const size = Number((yield* file.stat).size);

					if (size <= offset) {
						return new Uint8Array();
					}

					yield* file.seek(BigInt(offset), 'start');

					return Option.getOrElse(yield* file.readAlloc(size - offset), () => new Uint8Array());
				}).pipe(Effect.scoped);

			// By transcript path.
			const readContexts = new Map<string, ReadContext>();

			return ClaudeTranscript.of({
				contextTokens: (session, agentId) =>
					Effect.gen(function* () {
						const path = yield* transcriptPath(session, agentId);

						if (Option.isNone(path)) {
							return Option.none();
						}

						const read = readContexts.get(path.value) ?? { offset: 0, tokens: Option.none() };
						const appended = yield* appendedSince(path.value, read.offset);
						const end = appended.lastIndexOf(newline);

						if (end === -1) {
							return read.tokens;
						}

						const tokens = Option.orElse(latestContext(new TextDecoder().decode(appended.subarray(0, end)).split('\n')), () => read.tokens);

						readContexts.set(path.value, { offset: read.offset + end + 1, tokens });

						return tokens;
					}).pipe(notFoundAsNone),
			});
		}),
	);
}
