import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Permanent } from './call-policy.ts';
import { onTestFinished } from 'vitest';
import { defaultModelSelection, t3SettingsProblems } from './t3-settings.ts';

// T3's settings.json with `settings`, among keys sapphire-agent does not read, as T3 writes it.
const settingsFile = (settings: Record<string, unknown> | null) => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-t3-settings-'));
	const path = join(dir, 'settings.json');

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	if (settings !== null) {
		writeFileSync(path, JSON.stringify({ defaultAutoPull: true, branchNamePrefix: 'agent/', pullRequestMergeMethod: 'squash', ...settings }, null, 2));
	}

	return path;
};

const projects = [
	{ repo: '/home/dev/sapphire-agent', projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd' },
	{ repo: '/home/dev/telecord', projectId: null },
];

const cleans = (repo: string) => `T3 removes the worktrees of ${repo} itself: set its project's Automatic worktree cleanup to Off`;

describe('t3SettingsProblems', () => {
	it.effect("finds nothing wrong with T3's defaults, or with worktree cleanup off for every project", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* t3SettingsProblems(settingsFile(null), projects), []);
			assert.deepStrictEqual(yield* t3SettingsProblems(settingsFile({ storageCleanup: { logsAfterDays: 8 } }), projects), []);
			assert.deepStrictEqual(
				yield* t3SettingsProblems(settingsFile({ storageCleanup: { worktreeUnchanged: true }, worktreeCleanup: { mode: 'off' } }), projects),
				[],
			);
			assert.deepStrictEqual(
				yield* t3SettingsProblems(
					settingsFile({ worktreeCleanup: { mode: 'custom', rules: { worktreeAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: false } } }),
					projects,
				),
				[],
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("names each project whose worktrees T3 would remove, or whose merged threads it would not settle, after the project's own setting", () =>
		Effect.gen(function* () {
			const path = settingsFile({
				storageCleanup: { worktreeUnchanged: true, browserArtifactsAfterDays: 8, logsAfterDays: 8 },
				projectSettingsOverrides: { '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd': { worktreeCleanup: { mode: 'off' }, sidebarAutoSettleOnMerge: false } },
			});

			assert.deepStrictEqual(yield* t3SettingsProblems(path, projects), [
				'T3 does not settle the threads of /home/dev/sapphire-agent once their PR merged: turn on Auto-settle merged threads',
				cleans('/home/dev/telecord'),
			]);
			assert.deepStrictEqual(
				yield* t3SettingsProblems(settingsFile({ worktreeCleanup: { mode: 'custom', rules: { worktreeAfterDays: 14, worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: false } } }), projects),
				[cleans('/home/dev/sapphire-agent'), cleans('/home/dev/telecord')],
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect('fails on a settings file it cannot read', () =>
		Effect.gen(function* () {
			const path = settingsFile(null);

			writeFileSync(path, '{"storageCleanup": ');

			assert.strictEqual((yield* t3SettingsProblems(path, projects).pipe(Effect.flip))._tag, 'SchemaError');
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe('defaultModelSelection', () => {
	it.effect("reads the environment's default model, as T3 writes it with or without provider options", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* defaultModelSelection(join(import.meta.dirname, 'fixtures/t3/settings.json')), { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
			assert.deepStrictEqual(
				yield* defaultModelSelection(
					settingsFile({
						defaultModelSelection: {
							instanceId: 'codex',
							model: 'gpt-5.5-codex',
							options: [
								{ id: 'reasoningEffort', value: 'high' },
								{ id: 'fastMode', value: false },
							],
						},
					}),
				),
				{
					instanceId: 'codex',
					model: 'gpt-5.5-codex',
					options: [
						{ id: 'reasoningEffort', value: 'high' },
						{ id: 'fastMode', value: false },
					],
				},
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect('fails Permanent, asking for a default model, when the settings have none or there is no settings file', () =>
		Effect.gen(function* () {
			const absent = settingsFile({ storageCleanup: { logsAfterDays: 8 } });
			const cleared = settingsFile({ defaultModelSelection: null });
			const missing = settingsFile(null);

			assert.deepStrictEqual(yield* defaultModelSelection(absent).pipe(Effect.flip), new Permanent({ message: `T3's settings in ${absent} have no default model: set a default model in T3` }));
			assert.deepStrictEqual(yield* defaultModelSelection(cleared).pipe(Effect.flip), new Permanent({ message: `T3's settings in ${cleared} have no default model: set a default model in T3` }));
			assert.deepStrictEqual(yield* defaultModelSelection(missing).pipe(Effect.flip), new Permanent({ message: `T3's settings file ${missing} does not exist: set a default model in T3` }));
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
