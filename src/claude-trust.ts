import { randomUUID } from 'node:crypto';
import { Context, Effect, FileSystem, Layer, type PlatformError, Schema } from 'effect';
import { Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';

const Loose = Schema.Record(Schema.String, Schema.Unknown);

const Project = Schema.StructWithRest(Schema.Struct({ hasTrustDialogAccepted: Schema.optionalKey(Schema.Boolean) }), [Loose]);

// Only the fields the trust setup touches; every other field is kept as it is.
const ClaudeConfig = Schema.fromJsonString(Schema.StructWithRest(Schema.Struct({ projects: Schema.optionalKey(Schema.Record(Schema.String, Project)) }), [Loose]));

const attempts = 5;

export class ClaudeTrust extends Context.Service<
	ClaudeTrust,
	{
		// Pre-accepts Claude Code's folder trust dialog for `folder` in ~/.claude.json.
		readonly trustFolder: (folder: string) => Effect.Effect<void, Permanent | Transient>;
	}
>()('herdr-linear/ClaudeTrust') {
	static readonly layer = Layer.effect(
		ClaudeTrust,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { env } = yield* AppConfig;
			const path = env.claudeConfigPath;

			// Readers see either the old or the new file, never a partial write.
			const writeAtomic = (data: string) =>
				Effect.gen(function* () {
					const tempPath = `${path}.${randomUUID()}.tmp`;

					yield* Effect.scoped(
						Effect.gen(function* () {
							const file = yield* fs.open(tempPath, { flag: 'w', mode: 0o600 });

							yield* file.writeAll(new TextEncoder().encode(data));
							yield* file.sync;
						}),
					);
					yield* fs.rename(tempPath, path);
				});

			// Claude rewrites this file often, so the write only lands if the file is still what was read; otherwise it
			// starts over from the fresh contents.
			const attempt = (folder: string) =>
				Effect.gen(function* () {
					const before = yield* fs.readFileString(path);
					const config = yield* Schema.decodeEffect(ClaudeConfig)(before);
					const project = config.projects?.[folder];

					if (project?.hasTrustDialogAccepted) {
						return true;
					}

					const next = { ...config, projects: { ...config.projects, [folder]: { ...project, hasTrustDialogAccepted: true } } };

					yield* fs.copyFile(path, `${path}.herdr-linear.bak`);

					if ((yield* fs.readFileString(path)) !== before) {
						return false;
					}

					yield* writeAtomic(JSON.stringify(next, null, 2));

					return true;
				});

			return ClaudeTrust.of({
				trustFolder: (folder) =>
					Effect.gen(function* () {
						for (let tried = 0; tried < attempts; tried += 1) {
							if (yield* attempt(folder)) {
								return;
							}
						}

						return yield* new Transient({ message: `${path} kept changing; could not pre-accept the trust dialog for ${folder}` });
					}).pipe(
						Effect.catchTags({
							PlatformError: (error: PlatformError.PlatformError) => Effect.fail(new Permanent({ message: error.message, cause: error })),
							SchemaError: (error) => Effect.fail(new Permanent({ message: `${path}: ${error.message}`, cause: error })),
						}),
					),
			});
		}),
	);
}
