import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { AppConfig, transcriptionModel, transcriptionModelFiles } from './config.ts';
import { Transcriber } from './transcription.ts';

// The live service's state directory, whose model is only read.
const stateDirectory = join(homedir(), '.local/state/herdr/plugins/sapphire-agent');
const modelDirectory = join(stateDirectory, 'models', transcriptionModel);
const modelPresent = Object.values(transcriptionModelFiles).every((file) => existsSync(join(modelDirectory, file)));

const transcriberLayer = Transcriber.layer.pipe(Layer.provide(AppConfig.layerTest(stateDirectory)), Layer.provideMerge(NodeServices.layer));

describe.skipIf(!modelPresent)(modelPresent ? 'Transcriber' : `Transcriber (skipped: no ${transcriptionModel} in ${modelDirectory})`, () => {
	layer(transcriberLayer, { timeout: '1 minute', excludeTestServices: true })((it) => {
		it.effect('transcribes an OGG/Opus voice note', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const transcriber = yield* Transcriber;
				const directory = yield* fs.makeTempDirectoryScoped();
				const voiceNote = join(directory, 'voice.ogg');
				const exitCode = yield* spawner.exitCode(ChildProcess.make('ffmpeg', ['-v', 'error', '-i', join(modelDirectory, 'test_wavs/en.wav'), '-c:a', 'libopus', '-b:a', '32k', voiceNote]));

				assert.strictEqual(exitCode, 0);

				const transcript = yield* transcriber.transcribe(yield* fs.readFile(voiceNote));

				assert.strictEqual(transcript, 'Ask not what your country can do for you, ask what you can do for your country.');
			}),
		);

		it.effect('fails naming what ffmpeg could not decode', () =>
			Effect.gen(function* () {
				const transcriber = yield* Transcriber;
				const error = yield* transcriber.transcribe(new TextEncoder().encode('OggS but not really a voice note')).pipe(Effect.flip);

				assert.match(error.message, /^ffmpeg could not decode the audio: .*Invalid data found when processing input$/);
			}),
		);

		it.effect('fails on an empty voice note', () =>
			Effect.gen(function* () {
				const transcriber = yield* Transcriber;
				const error = yield* transcriber.transcribe(new Uint8Array()).pipe(Effect.flip);

				assert.strictEqual(error.message, 'empty audio: the voice note has no bytes');
			}),
		);
	});
});
