import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Fiber, FileSystem, Layer, Option, type PlatformError, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { projectSlug } from './claude-transcript.ts';
import { AppConfig } from './config.ts';
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

// One-word prompt of the keep-alive turn.
const keepAlivePrompt = 'ping';

// The main chat's Claude: the user's own `claude`, with their settings, CLAUDE.md, hooks and MCP servers, run once per
// message. Every turn gets a session of its own: a new one, or a fork of the session it continues (`--resume
// --fork-session`), which stays as it was, so any earlier message can be continued again.
export class ClaudeChat extends Context.Service<
	ClaudeChat,
	{
		// The reply's text, in pieces as Claude writes it. Interrupting the stream kills Claude, which ends the turn.
		readonly turn: (options: { readonly sessionId: string; readonly parent: Option.Option<string>; readonly prompt: string }) => Stream.Stream<string, ClaudeError>;
		// Resumes the session into a throwaway fork for one short turn, so the prompt cache of the session stays warm, then
		// deletes the fork's transcript.
		readonly keepAlive: (sessionId: string) => Effect.Effect<void, ClaudeError>;
	}
>()('sapphire-agent/ClaudeChat') {
	static readonly layer = Layer.effect(
		ClaudeChat,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;
			const prompts = yield* Prompts;
			// Sessions are kept per working directory, so every turn runs in the same one to resume the others.
			const cwd = homedir();
			const encoder = new TextEncoder();

			const command = (sessionId: string, parent: Option.Option<string>, prompt: string, outputArgs: ReadonlyArray<string>) =>
				ChildProcess.make(
					'claude',
					[
						'-p',
						...outputArgs,
						'--append-system-prompt',
						prompts.chat,
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

			const turn = ({ sessionId, parent, prompt }: { readonly sessionId: string; readonly parent: Option.Option<string>; readonly prompt: string }) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(command(sessionId, parent, prompt, ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'])).pipe(Effect.mapError(failure('start claude')));
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

			const keepAlive = (sessionId: string) =>
				Effect.gen(function* () {
					const fork = randomUUID();
					const exitCode = yield* Effect.scoped(
						spawner.spawn(command(fork, Option.some(sessionId), keepAlivePrompt, [])).pipe(
							Effect.flatMap((handle) => Effect.all([handle.stdout.pipe(Stream.runDrain), handle.stderr.pipe(Stream.runDrain), handle.exitCode], { concurrency: 'unbounded' })),
							Effect.map(([, , code]) => code),
						),
					).pipe(Effect.mapError(failure('keep the chat session warm')));

					yield* fs.remove(join(env.claudeConfigDirectory, 'projects', projectSlug(cwd), `${fork}.jsonl`), { force: true }).pipe(Effect.mapError(failure('delete the keep-alive fork')));

					if (exitCode !== 0) {
						return yield* new ClaudeError({ message: `claude exited with ${exitCode} keeping the chat session warm` });
					}
				});

			return ClaudeChat.of({ turn, keepAlive });
		}),
	);
}
