import { join } from 'node:path';
import { Effect, FileSystem, Option, Schema } from 'effect';
import { AppConfig, StartupError } from './config.ts';

const ClaimsFile = Schema.fromJsonString(Schema.Struct({ claims: Schema.Array(Schema.Unknown) }));

// The old dispatcher kept its runs in claims.json, which this code does not read. It refuses to start while that file
// still holds claims, so no run of the old dispatcher is left without anyone watching it.
export const refuseUndrainedClaims = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { env } = yield* AppConfig;
	const path = join(env.stateDirectory, 'claims.json');
	const text = yield* fs.readFileString(path).pipe(
		Effect.map(Option.some),
		Effect.catchTag('PlatformError', (error) =>
			error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(new StartupError({ problems: [`${path}: ${error.message}`] })),
		),
	);

	if (Option.isNone(text)) {
		return;
	}

	const { claims } = yield* Schema.decodeEffect(ClaimsFile)(text.value).pipe(
		Effect.mapError((error) => new StartupError({ problems: [`${path} is not a claims file: ${error.message}`] })),
	);

	if (claims.length > 0) {
		return yield* new StartupError({
			problems: [
				`${path} still holds ${claims.length} claim${claims.length === 1 ? '' : 's'} of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete ${path}.`,
			],
		});
	}
});
