import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Summariser } from './summariser.ts';

type ClaudeCall = { readonly command: string; readonly args: ReadonlyArray<string>; readonly input: string };

type ClaudeReply = { readonly stdout: string } | { readonly exitCode: number; readonly stderr: string };

const encoder = new TextEncoder();

const bytes = (text: string) => Stream.make(encoder.encode(text));

// The live layer over a fake `claude` that records each call and answers it with `reply`.
const liveWithClaude = (reply: ClaudeReply, settings: Parameters<typeof AppConfig.layerTest>[1] = {}) => {
	const calls: Array<ClaudeCall> = [];
	const spawner = ChildProcessSpawner.make((command) =>
		Effect.gen(function* () {
			if (command._tag !== 'StandardCommand') {
				return yield* Effect.die(new Error('expected a standard command'));
			}

			const input = Stream.isStream(command.options.stdin) ? yield* command.options.stdin.pipe(Stream.decodeText(), Stream.mkString) : '';
			const stdout = 'stdout' in reply ? reply.stdout : '';
			const stderr = 'stderr' in reply ? reply.stderr : '';

			calls.push({ command: command.command, args: command.args, input });

			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(4242),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode('exitCode' in reply ? reply.exitCode : 0)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: bytes(stdout),
				stderr: bytes(stderr),
				all: bytes(stdout + stderr),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			});
		}),
	);

	return {
		calls,
		layer: Summariser.layer.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)), Layer.provide(AppConfig.layerTest('/tmp/sapphire-agent-test', settings))),
	};
};

describe('Summariser', () => {
	it.effect('asks claude-haiku-5-5 by default, with the prompt on stdin, and answers its trimmed reply', () =>
		Effect.gen(function* () {
			const { calls, layer } = liveWithClaude({ stdout: 'TEST-10 now syncs over WebSockets.\n' });
			const summary = yield* Summariser.use((summariser) => summariser.summarise('Condense these edits.')).pipe(Effect.provide(layer));

			assert.strictEqual(summary, 'TEST-10 now syncs over WebSockets.');
			assert.deepStrictEqual(calls, [{ command: 'claude', args: ['-p', '--model', 'claude-haiku-5-5', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'], input: 'Condense these edits.' }]);
		}),
	);

	it.effect('asks the configured summaryModel', () =>
		Effect.gen(function* () {
			const { calls, layer } = liveWithClaude({ stdout: 'A summary.' }, { summaryModel: 'claude-sonnet-5' });

			yield* Summariser.use((summariser) => summariser.summarise('Condense these edits.')).pipe(Effect.provide(layer));

			assert.deepStrictEqual(calls[0].args.slice(0, 3), ['-p', '--model', 'claude-sonnet-5']);
		}),
	);

	it.effect('fails Permanent when claude exits non-zero', () =>
		Effect.gen(function* () {
			const { layer } = liveWithClaude({ exitCode: 1, stderr: 'API Error: 529 Overloaded\n' });
			const error = yield* Summariser.use((summariser) => summariser.summarise('Condense these edits.')).pipe(Effect.provide(layer), Effect.flip);

			assert.deepStrictEqual(error, new Permanent({ message: 'claude -p --model claude-haiku-5-5 failed with exit code 1: API Error: 529 Overloaded' }));
		}),
	);
});
