import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Schema, Sink, Stream, SubscriptionRef } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { projectSlug } from './claude-transcript.ts';

// One `claude` the fake ran: its arguments, working directory and the prompt it read on stdin.
export type FakeClaudeRun = {
	readonly args: ReadonlyArray<string>;
	readonly cwd: string | undefined;
	readonly prompt: string;
	// Whether it was killed before it was done.
	killed: boolean;
};

// How a run answers: the text pieces it streams, then it ends (or hangs, until killed). `failure` ends with an error
// result; `exitCode` and `stderr` as a crashing claude.
export type FakeClaudeAnswer = {
	readonly text?: ReadonlyArray<string>;
	// Text of a second message, after a tool call whose subagent writes text of its own.
	readonly afterToolCall?: ReadonlyArray<string>;
	readonly hang?: boolean;
	readonly failure?: string;
	readonly exitCode?: number;
	readonly stderr?: string;
};

export const flagValue = (args: ReadonlyArray<string>, flag: string) => {
	const index = args.indexOf(flag);

	return index === -1 ? null : args[index + 1];
};

// stream-json lines as Claude Code 2.1 prints them with --include-partial-messages and --verbose.
const event = (sessionId: string, body: Record<string, unknown>, parentToolUseId: string | null = null) => ({ type: 'stream_event', event: body, session_id: sessionId, parent_tool_use_id: parentToolUseId });

const textBlock = (sessionId: string, pieces: ReadonlyArray<string>) => [
	event(sessionId, { type: 'message_start', message: { role: 'assistant' } }),
	event(sessionId, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
	...pieces.map((piece) => event(sessionId, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })),
	event(sessionId, { type: 'content_block_stop', index: 0 }),
];

// The `system/init` event Claude Code 2.1 printed for a chat turn, recorded with the user's settings.
export const recordedInit = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
	readFileSync(join(import.meta.dirname, 'fixtures', 'claude', 'system-init.json'), 'utf8'),
);

const outputLines = (sessionId: string, { text = [], afterToolCall, failure }: FakeClaudeAnswer) => [
	{ ...recordedInit, session_id: sessionId },
	...textBlock(sessionId, text),
	...(afterToolCall === undefined
		? []
		: [
				event(sessionId, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} } }),
				event(sessionId, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'toolu_1'),
				event(sessionId, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'subagent notes' } }, 'toolu_1'),
				...textBlock(sessionId, afterToolCall),
			]),
	...(failure === undefined ? [] : [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: failure, session_id: sessionId }]),
];

const resultLine = (sessionId: string, text: ReadonlyArray<string>) => ({ type: 'result', subtype: 'success', is_error: false, result: text.join(''), session_id: sessionId });

// Stands in for the `claude` executable: each run answers as `answer` says and writes its session's transcript where
// Claude Code does, under `<claudeConfigDirectory>/projects`. A run that hangs is killed when its scope closes, as the
// live spawner kills the process group.
export const fakeClaude = (claudeConfigDirectory: string, answer: (run: FakeClaudeRun) => FakeClaudeAnswer) =>
	Effect.gen(function* () {
		const runs: Array<FakeClaudeRun> = [];
		const started = yield* SubscriptionRef.make(0);
		const encoder = new TextEncoder();

		const spawner = ChildProcessSpawner.make((command) =>
			Effect.gen(function* () {
				if (command._tag !== 'StandardCommand' || command.command !== 'claude') {
					return yield* Effect.die(new Error(`unexpected command ${command._tag === 'StandardCommand' ? command.command : 'pipe'}`));
				}

				const stdin = command.options.stdin;
				const prompt = typeof stdin === 'object' && Stream.isStream(stdin) ? yield* stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie) : '';
				const run: FakeClaudeRun = { args: command.args, cwd: command.options.cwd, prompt, killed: false };
				const sessionId = flagValue(command.args, '--session-id') ?? 'no-session';
				const { hang = false, exitCode = 0, stderr = '', ...output } = answer(run);
				let done = false;

				runs.push(run);
				yield* SubscriptionRef.update(started, (count) => count + 1);

				const projects = join(claudeConfigDirectory, 'projects', projectSlug(command.options.cwd ?? ''));

				mkdirSync(projects, { recursive: true });
				writeFileSync(join(projects, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: prompt } })}\n`);

				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						run.killed = !done;
					}),
				);

				const lines = [...outputLines(sessionId, output), ...(hang || output.failure !== undefined ? [] : [resultLine(sessionId, output.text ?? [])])].map((line) => encoder.encode(`${JSON.stringify(line)}\n`));
				const stdout = hang
					? Stream.concat(Stream.fromIterable(lines), Stream.never)
					: Stream.fromIterable(lines).pipe(
							Stream.ensuring(
								Effect.sync(() => {
									done = true;
								}),
							),
						);

				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(runs.length),
					exitCode: hang ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
					isRunning: Effect.sync(() => !done),
					kill: () => Effect.void,
					stdin: Sink.drain,
					stdout,
					stderr: Stream.make(encoder.encode(stderr)),
					all: Stream.empty,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		);

		return {
			runs,
			// Completes once n runs have started.
			awaitRuns: (n: number) =>
				SubscriptionRef.changes(started).pipe(
					Stream.takeUntil((count) => count >= n),
					Stream.runDrain,
				),
			layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
		};
	});
