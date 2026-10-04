import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Journal, type Run } from './journal.ts';

const status = (stateDirectory: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make(process.execPath, [join(import.meta.dirname, 'status.ts')], { extendEnv: false, env: { HERDR_PLUGIN_STATE_DIR: stateDirectory } }),
		);
		const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);

		return { output, exitCode: yield* handle.exitCode };
	});

const run: Run = {
	epicId: 'issue-unb-12',
	identifier: 'UNB-12',
	teamId: 'team-unbound',
	status: 'awaitingInput',
	job: { _tag: 'follow-up', threadIds: ['PRRT_1'] },
	repo: '/home/dev/unbound',
	branch: 'mario/unb-12-settings-sync',
	worktreePath: '/home/dev/.herdr/worktrees/unbound/mario-unb-12-settings-sync',
	tabId: 'w1:t3',
	paneId: 'w1:p3',
	claimedAt: Date.UTC(2026, 9, 4, 9, 30),
	startedAt: Date.UTC(2026, 9, 4, 9, 31),
	agentStatus: 'idle',
	agentStatusSince: Date.UTC(2026, 9, 4, 9, 40),
	nudgedAt: null,
	tailHash: null,
	result: null,
	questionCommentId: 'comment-1',
	deliveredReplyIds: [],
};

describe('status', () => {
	it.live('prints every run in the journal', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();

			yield* Effect.gen(function* () {
				const journal = yield* Journal;

				yield* journal.putRun(run);
				yield* journal.putRun({ ...run, epicId: 'issue-unb-13', identifier: 'UNB-13', status: 'claimed', job: { _tag: 'orchestrate' }, claimedAt: run.claimedAt + 60_000, worktreePath: null, tabId: null, paneId: null });
			}).pipe(Effect.provide(Journal.layer(join(directory, 'journal.db'))));

			assert.deepStrictEqual(yield* status(directory), {
				output: [
					'UNB-12 awaitingInput (follow-up), claimed 2026-10-04T09:30:00.000Z, tab w1:t3, /home/dev/.herdr/worktrees/unbound/mario-unb-12-settings-sync',
					'UNB-13 claimed (orchestrate), claimed 2026-10-04T09:31:00.000Z, no tab, no worktree',
					'',
				].join('\n'),
				exitCode: 0,
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('says so when nothing is tracked', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();

			assert.deepStrictEqual(yield* status(directory), { output: 'no runs\n', exitCode: 0 });
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
