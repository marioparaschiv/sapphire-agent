import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';

// Only the entries that tell whether the agent still waits on a message; every other entry is skipped.
const Entry = Schema.fromJsonString(
	Schema.Union([
		Schema.Struct({ type: Schema.Literal('assistant'), message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }) }),
		Schema.Struct({ type: Schema.Literal('user'), message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) }) }),
	]),
);

const SentMessage = Schema.Struct({ type: Schema.Literal('tool_use'), name: Schema.Literal('SendMessage'), input: Schema.Struct({ to: Schema.String, message: Schema.String }) });

const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String });

const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeSentMessage = Schema.decodeUnknownOption(SentMessage);
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock);

// A prompt, a message from another session or an interrupt; not a tool result. A background task finishing wakes the
// agent too, but answers nothing it asked.
const isInput = (content: string | ReadonlyArray<unknown>) => {
	const texts = typeof content === 'string' ? [content] : content.flatMap((block) => Option.toArray(Option.map(decodeTextBlock(block), (text) => text.text)));

	return texts.some((text) => !text.startsWith('<task-notification>'));
};

// Claude Code names a project's directory after its path, shortened past 200 characters with a hash of the path appended.
const maxSlugLength = 200;

export class ClaudeTranscript extends Context.Service<
	ClaudeTranscript,
	{
		// The last message the session sent `to` with no input since: the question it ended its turn on. None when it got
		// input after it, never sent one, or has no transcript.
		readonly pendingMessage: (session: { readonly id: string; readonly cwd: string }, to: string) => Effect.Effect<Option.Option<string>, Permanent>;
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
					const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');

					if (slug.length <= maxSlugLength) {
						return Option.some(slug);
					}

					return Option.fromUndefinedOr((yield* fs.readDirectory(projects)).find((name) => name.startsWith(`${slug.slice(0, maxSlugLength)}-`)));
				});

			const pendingIn = (lines: ReadonlyArray<string>, to: string): Option.Option<string> => {
				for (const line of lines.toReversed()) {
					const entry = decodeEntry(line);

					if (Option.isNone(entry)) {
						continue;
					}

					if (entry.value.type === 'user') {
						if (isInput(entry.value.message.content)) {
							return Option.none();
						}

						continue;
					}

					const sent = entry.value.message.content.flatMap((block) => Option.toArray(decodeSentMessage(block))).findLast((block) => block.input.to === to);

					if (sent) {
						return Option.some(sent.input.message);
					}
				}

				return Option.none();
			};

			return ClaudeTranscript.of({
				pendingMessage: (session, to) =>
					Effect.gen(function* () {
						const directory = yield* projectDirectory(session.cwd);

						if (Option.isNone(directory)) {
							return Option.none();
						}

						const text = yield* fs.readFileString(join(projects, directory.value, `${session.id}.jsonl`));

						return pendingIn(text.split('\n'), to);
					}).pipe(
						Effect.catchTag('PlatformError', (error) =>
							error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(new Permanent({ message: error.message, cause: error })),
						),
					),
			});
		}),
	);
}
