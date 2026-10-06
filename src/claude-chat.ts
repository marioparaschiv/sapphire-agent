import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Fiber, FileSystem, Layer, Option, type PlatformError, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { InitEvent } from './claude-settings.ts';
import { projectSlug } from './claude-transcript.ts';
import { AppConfig } from './config.ts';
import type { ChatSession, ProjectSettings } from './journal.ts';
import { Prompts } from './prompts.ts';

export class ClaudeError extends Schema.TaggedError<ClaudeError>()('ClaudeError', { message: Schema.String }) {}

// What a turn's `--output-format stream-json --include-partial-messages` lines say that the chat shows: text as it is
// generated, where a new text block starts, and the result. Subagents' events (parent_tool_use_id set) are left out.
const OutputLine = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('stream_event'),
		parent_tool_use_id: Schema.Null,
		event: Schema.Union([
			Schema.Struct({ type: Schema.Literal('content_block_start'), content_block: Schema.Struct({ type: Schema.Literal('text') }) }),
			Schema.Struct({ type: Schema.Literal('content_block_delta'), delta: Schema.Struct({ type: Schema.Literal('text_delta'), text: Schema.String }) }),
		]),
	}),
	Schema.Struct({ type: Schema.Literal('result'), is_error: Schema.Boolean, result: Schema.optionalKey(Schema.String) }),
]);

const decodeOutputLine = Schema.decodeUnknownOption(Schema.fromJsonString(OutputLine));

// Told apart from the hook events printed before it, then decoded in full, so a changed event fails before the model is called.
const decodeAnyInitLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('system'), subtype: Schema.Literal('init') })));

const isInitLine = (line: string) => Option.isSome(decodeAnyInitLine(line));

const decodeInitLine = Schema.decodeUnknownEffect(Schema.fromJsonString(InitEvent));

type Output = { readonly _tag: 'blockStart' } | { readonly _tag: 'text'; readonly text: string };

const outputOf = (line: string): Effect.Effect<ReadonlyArray<Output>, ClaudeError> =>
	Option.match(decodeOutputLine(line), {
		onNone: () => Effect.succeed([]),
		onSome: (output) => {
			if (output.type === 'result') {
				return output.is_error ? Effect.fail(new ClaudeError({ message: `Claude failed: ${output.result ?? 'no reason given'}` })) : Effect.succeed([]);
			}

			return Effect.succeed([output.event.type === 'content_block_start' ? { _tag: 'blockStart' } : { _tag: 'text', text: output.event.delta.text }]);
		},
	});

const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';

export type ChatTurn = {
	readonly sessionId: string;
	readonly parent: Option.Option<string>;
	readonly prompt: string;
	// Claude keeps sessions per directory, so a fork runs in its parent's.
	readonly cwd: string;
	// The project whose topic the turn is in; none in the main chat.
	readonly project: ProjectSettings | null;
};

// One-word prompt of the keep-alive turn, and of the settings check, which is killed before it is answered.
const pingPrompt = 'ping';

// The user's, the project's and the local settings, named so that no default leaves one of them out.
const settingSources = 'user,project,local';

// The chat's Claude: the user's own `claude`, with their settings, CLAUDE.md, hooks and MCP servers, run once per
// message in the main chat or a project's topic. Every turn gets a session of its own: a new one, or a fork of the
// session it continues (`--resume --fork-session`), which stays as it was, so any earlier message can be continued again.
export class ClaudeChat extends Context.Service<
	ClaudeChat,
	{
		// What a turn runs with, read from its `system/init` event; Claude is killed before it calls the model.
		readonly init: Effect.Effect<InitEvent, ClaudeError>;
		// The reply's text, in pieces as Claude writes it. Interrupting the stream kills Claude, which ends the turn.
		readonly turn: (turn: ChatTurn) => Stream.Stream<string, ClaudeError>;
		// Resumes the session into a throwaway fork for one short turn, so the prompt cache of the session stays warm, then
		// deletes the fork's transcript.
		readonly keepAlive: (session: ChatSession) => Effect.Effect<void, ClaudeError>;
	}
>()('sapphire-agent/ClaudeChat') {
	static readonly layer = Layer.effect(
		ClaudeChat,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;
			const prompts = yield* Prompts;
			const encoder = new TextEncoder();

			const command = ({ sessionId, parent, prompt, cwd, project }: ChatTurn, outputArgs: ReadonlyArray<string>) =>
				ChildProcess.make(
					'claude',
					[
						'-p',
						...outputArgs,
						'--setting-sources',
						settingSources,
						'--append-system-prompt',
						project === null ? prompts.chat : prompts.projectChat(project),
						'--session-id',
						sessionId,
						...Option.match(parent, { onNone: () => [], onSome: (id) => ['--resume', id, '--fork-session'] }),
					],
					// On stdin, so a prompt starting with a dash is never read as an option.
					{ cwd, stdin: Stream.make(encoder.encode(prompt)) },
				);

			const failure = (what: string) => (error: { readonly message: string }) => new ClaudeError({ message: `cannot ${what}: ${error.message}` });

			const exited = (handle: ChildProcessSpawner.ChildProcessHandle, stderr: Fiber.Fiber<string, PlatformError.PlatformError>) =>
				Effect.gen(function* () {
					const exitCode = yield* handle.exitCode;

					if (exitCode !== 0) {
						return yield* new ClaudeError({ message: `claude exited with ${exitCode}: ${lastLine(yield* Fiber.join(stderr))}` });
					}
				}).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(failure('run claude')(error))));

			// The scope closing kills Claude once the event is read. Nothing is kept of the session.
			const init = Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(command({ sessionId: randomUUID(), parent: Option.none(), prompt: pingPrompt, cwd: homedir(), project: null }, ['--output-format', 'stream-json', '--verbose', '--no-session-persistence'])).pipe(Effect.mapError(failure('start claude')));

					return yield* handle.stdout.pipe(
						Stream.decodeText(),
						Stream.splitLines,
						Stream.filter(isInitLine),
						Stream.runHead,
						Effect.mapError(failure('read claude')),
						Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ClaudeError({ message: 'claude ended without a system/init event' })), onSome: Effect.succeed })),
						Effect.flatMap((line) => decodeInitLine(line).pipe(Effect.mapError(failure('read the system/init event')))),
					);
				}),
			);

			const turn = (chatTurn: ChatTurn) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(command(chatTurn, ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'])).pipe(Effect.mapError(failure('start claude')));
						const stderr = yield* handle.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped);

						return handle.stdout.pipe(
							Stream.decodeText(),
							Stream.splitLines,
							Stream.mapError(failure('read claude')),
							Stream.mapEffect(outputOf),
							Stream.flattenIterable,
							// Text blocks of later messages in the turn (after a tool call) start on a paragraph of their own.
							Stream.mapAccum(
								() => ({ wrote: false, newBlock: false }),
								(state, output): readonly [{ wrote: boolean; newBlock: boolean }, ReadonlyArray<string>] => {
									if (output._tag === 'blockStart') {
										return [{ ...state, newBlock: true }, []];
									}

									return [{ wrote: true, newBlock: false }, [state.wrote && state.newBlock ? `\n\n${output.text}` : output.text]];
								},
							),
							Stream.concat(Stream.fromEffect(exited(handle, stderr)).pipe(Stream.drain)),
						);
					}),
				);

			const keepAlive = ({ sessionId, cwd }: ChatSession) =>
				Effect.gen(function* () {
					const fork = randomUUID();
					const exitCode = yield* Effect.scoped(
						spawner.spawn(command({ sessionId: fork, parent: Option.some(sessionId), prompt: pingPrompt, cwd, project: null }, [])).pipe(
							Effect.flatMap((handle) => Effect.all([handle.stdout.pipe(Stream.runDrain), handle.stderr.pipe(Stream.runDrain), handle.exitCode], { concurrency: 'unbounded' })),
							Effect.map(([, , code]) => code),
						),
					).pipe(Effect.mapError(failure('keep the chat session warm')));

					yield* fs.remove(join(env.claudeConfigDirectory, 'projects', projectSlug(cwd), `${fork}.jsonl`), { force: true }).pipe(Effect.mapError(failure('delete the keep-alive fork')));

					if (exitCode !== 0) {
						return yield* new ClaudeError({ message: `claude exited with ${exitCode} keeping the chat session warm` });
					}
				});

			return ClaudeChat.of({ init, turn, keepAlive });
		}),
	);
}
