import { Context, Effect, Layer, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { type CallError, callTimeouts, Permanent, timeoutAsTransient } from './call-policy.ts';
import { AppConfig } from './config.ts';

export class Summariser extends Context.Service<
	Summariser,
	{
		// The configured summaryModel's answer to the prompt.
		readonly summarise: (prompt: string) => Effect.Effect<string, CallError>;
	}
>()('sapphire-agent/Summariser') {
	// `claude -p` with the prompt on stdin, no tools and no saved session. One attempt: its callers have a fallback, so a
	// retry would only hold up the tick.
	static readonly layer = Layer.effect(
		Summariser,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { summaryModel } = yield* AppConfig;
			const encoder = new TextEncoder();
			const args = ['-p', '--model', summaryModel, '--tools', '', '--no-session-persistence'];
			const command = `claude -p --model ${summaryModel}`;
			const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString);

			const summarise = (prompt: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(ChildProcess.make('claude', args, { stdin: Stream.make(encoder.encode(prompt)) }));
						const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						if (exitCode !== 0) {
							return yield* new Permanent({ message: `${command} failed with exit code ${exitCode}: ${stderr.trim()}` });
						}

						const summary = stdout.trim();

						return summary === '' ? yield* new Permanent({ message: `${command} answered nothing` }) : summary;
					}),
				).pipe(
					Effect.catchTag('PlatformError', (error) => Effect.fail(new Permanent({ message: `${command}: ${error.message}`, cause: error }))),
					timeoutAsTransient(callTimeouts.claude),
				);

			return Summariser.of({ summarise });
		}),
	);
}
