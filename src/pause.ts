import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, type PlatformError } from 'effect';
import { AppConfig } from './config.ts';

// The pause file in the state directory: `sapphire pause` creates it and `sapphire resume` removes it.
export class Pause extends Context.Service<
	Pause,
	{
		readonly path: string;
		readonly isPaused: Effect.Effect<boolean, PlatformError.PlatformError>;
		readonly pause: Effect.Effect<void, PlatformError.PlatformError>;
		readonly resume: Effect.Effect<void, PlatformError.PlatformError>;
	}
>()('sapphire-agent/Pause') {
	static readonly layer = Layer.effect(
		Pause,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;
			const path = join(env.stateDirectory, 'paused');

			return Pause.of({ path, isPaused: fs.exists(path), pause: fs.writeFileString(path, ''), resume: fs.remove(path, { force: true }) });
		}),
	);
}
