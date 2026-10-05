import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

const appPem = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;

describe('main', () => {
	it.live('reports every config error in one message and exits non-zero', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const directory = yield* fs.makeTempDirectoryScoped();

			yield* fs.writeFileString(join(directory, 'config.json'), JSON.stringify({ pollSeconds: 2, maxInflight: 3, teams: { Unbound: { repo: '~/unbound' } }, bot: { login: 'orchestratorbot', app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') }, allowedUsers: ['marioparaschiv'] } }));
			yield* fs.writeFileString(join(directory, 'linear-key'), 'lin_api_secret', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'app.pem'), appPem, { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'webhook-secret'), 'whsec_test', { mode: 0o600 });

			const handle = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [join(import.meta.dirname, 'main.ts')], {
					extendEnv: false,
					env: {
						HERDR_SOCKET_PATH: join(directory, 'herdr.sock'),
						HERDR_PLUGIN_CONFIG_DIR: directory,
						HERDR_PLUGIN_STATE_DIR: directory,
						SAPPHIRE_AGENT_LINEAR_KEY_FILE: join(directory, 'linear-key'),
					},
				}),
			);
			const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);
			const exitCode = yield* handle.exitCode;
			const errorLines = output.split('\n').filter((line) => line.includes('ERROR'));

			assert.notStrictEqual(exitCode, 0);
			assert.lengthOf(errorLines, 1);
			assert.match(output, /- HERDR_BIN_PATH: /);
			assert.match(output, /- \S+config\.json pollSeconds: Expected a value greater than or equal to 5/);
			assert.match(output, /- \S+config\.json maxInflight: Expected no excess property/);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('refuses to start while the old claims.json holds claims', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const directory = yield* fs.makeTempDirectoryScoped();

			yield* fs.writeFileString(join(directory, 'config.json'), JSON.stringify({ teams: { Unbound: { repo: join(directory, 'unbound') } }, bot: { login: 'orchestratorbot', app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') }, allowedUsers: ['marioparaschiv'] } }));
			yield* fs.writeFileString(join(directory, 'linear-key'), 'lin_api_secret', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'app.pem'), appPem, { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'webhook-secret'), 'whsec_test', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'claims.json'), JSON.stringify({ claims: [{ epicId: 'b1c2d3', identifier: 'UNB-12', status: 'running' }] }));

			const handle = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [join(import.meta.dirname, 'main.ts')], {
					extendEnv: false,
					env: {
						HERDR_BIN_PATH: join(directory, 'herdr'),
						HERDR_SOCKET_PATH: join(directory, 'herdr.sock'),
						HERDR_PLUGIN_CONFIG_DIR: directory,
						HERDR_PLUGIN_STATE_DIR: directory,
						SAPPHIRE_AGENT_LINEAR_KEY_FILE: join(directory, 'linear-key'),
						CLAUDE_CONFIG_PATH: join(directory, 'claude.json'),
					},
				}),
			);
			const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);
			const exitCode = yield* handle.exitCode;

			assert.notStrictEqual(exitCode, 0);
			assert.include(output, `${join(directory, 'claims.json')} still holds 1 claim of the old dispatcher. Drain it first`);
			assert.notInclude(output, 'watching Unbound');
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
