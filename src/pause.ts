import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, type PlatformError } from 'effect';
import { AppConfig } from './config.ts';

// `scripts/ctl.sh pause` creates this file and `resume` removes it.
const pauseFileName = 'paused';

export class Pause extends Context.Service<Pause, { readonly isPaused: Effect.Effect<boolean, PlatformError.PlatformError> }>()('herdr-linear/Pause') {
	static readonly layer = Layer.effect(
		Pause,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;

			return Pause.of({ isPaused: fs.exists(join(env.stateDirectory, pauseFileName)) });
		}),
	);
}
