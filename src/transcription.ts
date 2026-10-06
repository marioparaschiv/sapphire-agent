import { join } from 'node:path';
import { Context, Effect, Layer, type PlatformError, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import sherpa from 'sherpa-onnx-node';
import { TelegramConfig, transcriptionModelFiles } from './config.ts';

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()('TranscriptionError', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const sampleRate = 16_000;

const RecognizerResult = Schema.Struct({ text: Schema.String });

const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';

export class Transcriber extends Context.Service<
	Transcriber,
	{
		// `audio` is a voice note file as Telegram sends it (OGG/Opus); any format ffmpeg reads works.
		readonly transcribe: (audio: Uint8Array) => Effect.Effect<string, TranscriptionError>;
	}
>()('sapphire-agent/Transcriber') {
	static readonly layer = Layer.effect(
		Transcriber,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { transcriptionModelDirectory } = yield* TelegramConfig;
			const model = (file: string) => join(transcriptionModelDirectory, file);
			const recognizer = yield* Effect.tryPromise({
				try: () =>
					sherpa.OfflineRecognizer.createAsync({
						featConfig: { sampleRate, featureDim: 80 },
						modelConfig: {
							transducer: { encoder: model(transcriptionModelFiles.encoder), decoder: model(transcriptionModelFiles.decoder), joiner: model(transcriptionModelFiles.joiner) },
							tokens: model(transcriptionModelFiles.tokens),
							modelType: 'nemo_transducer',
							numThreads: 4,
						},
					}),
				catch: (cause) => new TranscriptionError({ message: `the recognizer could not load the model in ${transcriptionModelDirectory}: ${cause}`, cause }),
			});

			// Raw 32-bit float samples are what the recognizer takes, and unlike WAV need no header ffmpeg cannot finish on a pipe.
			const toSamples = (audio: Uint8Array) =>
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(
							ChildProcess.make('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), 'pipe:1'], { stdin: Stream.make(audio) }),
						);
						const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));
						const [pcm, stderr, exitCode] = yield* Effect.all([Stream.mkUint8Array(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						return { pcm, stderr, exitCode };
					}),
				).pipe(
					Effect.mapError((error) => new TranscriptionError({ message: `ffmpeg could not run: ${error.message}`, cause: error })),
					Effect.flatMap(({ pcm, stderr, exitCode }) => {
						if (exitCode !== 0) {
							return Effect.fail(new TranscriptionError({ message: `ffmpeg could not decode the audio: ${lastLine(stderr) || `exit code ${exitCode}`}` }));
						}

						if (pcm.byteLength === 0) {
							return Effect.fail(new TranscriptionError({ message: 'empty audio: ffmpeg decoded no samples' }));
						}

						return Effect.succeed(new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)));
					}),
				);

			const recognize = (samples: Float32Array) =>
				Effect.tryPromise({
					try: () => {
						const stream = recognizer.createStream();

						stream.acceptWaveform({ samples, sampleRate });

						return recognizer.decodeAsync(stream);
					},
					catch: (cause) => new TranscriptionError({ message: `the recognizer failed: ${cause}`, cause }),
				}).pipe(
					Effect.flatMap((result) => Schema.decodeUnknownEffect(RecognizerResult)(result)),
					Effect.catchTag('SchemaError', (error) => Effect.fail(new TranscriptionError({ message: `the recognizer returned an unexpected result: ${error.message}`, cause: error }))),
				);

			return Transcriber.of({
				transcribe: (audio) =>
					Effect.gen(function* () {
						if (audio.byteLength === 0) {
							return yield* new TranscriptionError({ message: 'empty audio: the voice note has no bytes' });
						}

						const { text } = yield* recognize(yield* toSamples(audio));
						const transcript = text.trim();

						if (!transcript) {
							return yield* new TranscriptionError({ message: 'no speech recognized' });
						}

						return transcript;
					}),
			});
		}),
	);

	// Treats the audio bytes as the transcript's UTF-8 text, so tests can send voice notes without the model.
	static readonly layerTest = Layer.succeed(
		Transcriber,
		Transcriber.of({
			transcribe: (audio) => {
				const transcript = new TextDecoder().decode(audio).trim();

				return transcript ? Effect.succeed(transcript) : Effect.fail(new TranscriptionError({ message: 'no speech recognized' }));
			},
		}),
	);
}
