import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { BaseSqliteStorage, TelegramClient } from '@mtcute/node';
import { Effect, FileSystem } from 'effect';
import { NodeSqliteStorageDriver } from './telegram-bot.ts';

// A client that is never connected: preparing it only loads its storage.
const prepared = (filename: string) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			const client = new TelegramClient({ apiId: 1_234_567, apiHash: 'test-api-hash', storage: new BaseSqliteStorage(new NodeSqliteStorageDriver(filename)) });

			await client.prepare();

			return client;
		}),
		(client) => Effect.promise(() => client.destroy()),
	);

describe('NodeSqliteStorageDriver', () => {
	it.effect('keeps mtcute update state in the session file across a restart', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const filename = join(yield* fs.makeTempDirectoryScoped(), 'telegram.session');

			yield* Effect.scoped(
				Effect.gen(function* () {
					const { storage } = yield* prepared(filename);

					assert.isNull(yield* Effect.promise(async () => storage.updates.getState()));
					yield* Effect.promise(async () => {
						await storage.updates.setPts(4_210);
						await storage.updates.setQts(17);
						await storage.updates.setDate(1_791_000_000);
						await storage.updates.setSeq(305);
					});
				}),
			);

			const { storage } = yield* prepared(filename);

			assert.deepStrictEqual(yield* Effect.promise(async () => storage.updates.getState()), [4_210, 17, 1_791_000_000, 305]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
