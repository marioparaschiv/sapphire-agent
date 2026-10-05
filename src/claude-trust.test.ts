import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, FileSystem, Layer } from 'effect';
import { onTestFinished } from 'vitest';
import { Transient } from './call-policy.ts';
import { ClaudeTrust } from './claude-trust.ts';
import { AppConfig } from './config.ts';

const worktree = '/home/dev/.herdr/worktrees/unbound/mario-unb-12';

const realistic = {
	numStartups: 412,
	installMethod: 'native',
	autoUpdates: false,
	tipsHistory: { 'new-user-warmup': 7, 'shift-enter': 412 },
	userID: '5b0c1f0e9e3d4c7a',
	oauthAccount: { accountUuid: 'a1b2c3', emailAddress: 'dev@example.com', organizationRole: 'admin', displayName: 'dev' },
	mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
	projects: {
		'/home/dev': { allowedTools: [], hasTrustDialogAccepted: false, lastCost: 0.17, mcpServers: {}, lastModelUsage: { 'claude-opus': { inputTokens: 1200 } } },
		[worktree]: { lastSessionId: 'd483ae2a', exampleFiles: ['src/main.ts'], projectOnboardingSeenCount: 2 },
		'/home/dev/sapphire-agent': { hasTrustDialogAccepted: true, allowedTools: ['Bash(npm test)'] },
	},
	cachedChangelog: '# Changelog\n\n## 2.1.0\n',
	hasCompletedOnboarding: true,
};

const configFile = (contents: string) => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-trust-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, 'claude.json'), contents, { mode: 0o600 });

	return { dir, path: join(dir, 'claude.json') };
};

const trustLayer = (dir: string, fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer) =>
	ClaudeTrust.layer.pipe(Layer.provide(AppConfig.layerTest(dir)), Layer.provide(fileSystem));

describe('ClaudeTrust', () => {
	it.effect('pre-accepts the trust dialog for a folder, keeping every other field and a backup', () => {
		const { dir, path } = configFile(JSON.stringify(realistic, null, 2));

		return Effect.gen(function* () {
			const { trustFolder } = yield* ClaudeTrust;

			yield* trustFolder(worktree);
			yield* trustFolder('/home/dev/.herdr/worktrees/telecord/mario-tel-3');

			assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), {
				...realistic,
				projects: {
					...realistic.projects,
					[worktree]: { ...realistic.projects[worktree], hasTrustDialogAccepted: true },
					'/home/dev/.herdr/worktrees/telecord/mario-tel-3': { hasTrustDialogAccepted: true },
				},
			});
			assert.strictEqual(statSync(path).mode & 0o777, 0o600);
			assert.deepStrictEqual(JSON.parse(readFileSync(`${path}.sapphire-agent.bak`, 'utf8')), {
				...realistic,
				projects: { ...realistic.projects, [worktree]: { ...realistic.projects[worktree], hasTrustDialogAccepted: true } },
			});
		}).pipe(Effect.provide(trustLayer(dir)));
	});

	it.effect('leaves the file alone when the folder is already trusted', () => {
		const contents = JSON.stringify(realistic, null, '\t');
		const { dir, path } = configFile(contents);
		const inode = statSync(path).ino;

		return Effect.gen(function* () {
			yield* (yield* ClaudeTrust).trustFolder('/home/dev/sapphire-agent');

			assert.strictEqual(readFileSync(path, 'utf8'), contents);
			assert.strictEqual(statSync(path).ino, inode);
			assert.isFalse(existsSync(`${path}.sapphire-agent.bak`));
		}).pipe(Effect.provide(trustLayer(dir)));
	});

	it.effect('fails loudly on a config that is not JSON instead of overwriting it', () => {
		const { dir, path } = configFile('{"projects": {');

		return Effect.gen(function* () {
			const error = yield* Effect.flip((yield* ClaudeTrust).trustFolder(worktree));

			assert.strictEqual(error._tag, 'Permanent');
			assert.match(error.message, new RegExp(`^${path}: `));
			assert.strictEqual(readFileSync(path, 'utf8'), '{"projects": {');
		}).pipe(Effect.provide(trustLayer(dir)));
	});

	it.effect('fails when Claude rewrites the file during every attempt, without overwriting its changes', () => {
		const { dir, path } = configFile(JSON.stringify(realistic));
		let rewrites = 0;
		// Claude saves the file again right after each backup, so the re-read never matches.
		const busyFileSystem = Layer.effect(
			FileSystem.FileSystem,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;

				return FileSystem.FileSystem.of({
					...fs,
					copyFile: (from, to) =>
						fs.copyFile(from, to).pipe(
							Effect.andThen(Effect.sync(() => (rewrites += 1))),
							Effect.andThen((count) => fs.writeFileString(path, JSON.stringify({ ...realistic, numStartups: realistic.numStartups + count }))),
						),
				});
			}),
		).pipe(Layer.provide(NodeServices.layer));

		return Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* Effect.exit((yield* ClaudeTrust).trustFolder(worktree)),
				Exit.fail(new Transient({ message: `${path} kept changing; could not pre-accept the trust dialog for ${worktree}` })),
			);
			assert.strictEqual(rewrites, 5);
			assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), { ...realistic, numStartups: 417 });
		}).pipe(Effect.provide(trustLayer(dir, busyFileSystem)));
	});
});
