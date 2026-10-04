import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Journal, type Run } from './journal.ts';

const orchestrate: Run = {
	epicId: 'epic-1',
	identifier: 'HL-9',
	teamId: 'team-1',
	status: 'claimed',
	job: { _tag: 'orchestrate' },
	repo: '/home/dev/herdr-linear',
	branch: 'mario/hl-9-foundation',
	worktreePath: null,
	tabId: null,
	paneId: null,
	claimedAt: 1_000,
	startedAt: null,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	tailHash: null,
	result: null,
	questionCommentId: null,
	deliveredReplyIds: [],
};

const followUp: Run = {
	epicId: 'epic-2',
	identifier: 'HL-10',
	teamId: 'team-1',
	status: 'awaitingInput',
	job: { _tag: 'follow-up', threadIds: ['PRRT_1', 'PRRT_2'] },
	repo: '/home/dev/unbound-app/loader-ios',
	branch: 'mario/hl-10-linear',
	worktreePath: '/home/dev/.herdr/worktrees/loader-ios/mario-hl-10-linear',
	tabId: 'w1:t3',
	paneId: 'w1:p7',
	claimedAt: 500,
	startedAt: 2_000,
	agentStatus: 'blocked',
	agentStatusSince: 3_000,
	nudgedAt: 4_000,
	tailHash: 'f3a1',
	result: {
		summary: 'Added the Linear service.',
		replies: [{ threadId: 'PRRT_1', body: 'Fixed.' }],
		flags: [{ path: 'src/linear.ts', line: 12, body: 'Check the page size.' }],
	},
	questionCommentId: 'comment-9',
	deliveredReplyIds: ['reply-1'],
};

describe('Journal', () => {
	it.effect('round-trips runs through SQLite with their schema types', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;

			yield* journal.putRun(orchestrate);
			yield* journal.putRun(followUp);

			assert.deepStrictEqual(yield* journal.getRun('epic-2'), Option.some(followUp));
			assert.deepStrictEqual(yield* journal.listRuns, [followUp, orchestrate]);

			const running: Run = { ...orchestrate, status: 'running', tabId: 'w1:t4', paneId: 'w1:p8', startedAt: 1_500, agentStatus: 'working', agentStatusSince: 1_500 };

			yield* journal.putRun(running);
			assert.deepStrictEqual(yield* journal.getRun('epic-1'), Option.some(running));

			yield* journal.deleteRun('epic-1');
			assert.deepStrictEqual(yield* journal.getRun('epic-1'), Option.none());
			assert.deepStrictEqual(yield* journal.listRuns, [followUp]);
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
	);

	it.effect('keeps the start of a transient failure streak until it is cleared', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;

			yield* TestClock.setTime(10_000);
			assert.strictEqual(yield* journal.recordTransient('epic-1'), 10_000);

			yield* TestClock.adjust('5 minutes');
			assert.strictEqual(yield* journal.recordTransient('epic-1'), 10_000);
			assert.strictEqual(yield* journal.recordTransient('epic-2'), 310_000);

			yield* journal.clearTransient('epic-1');
			yield* TestClock.adjust('1 minute');
			assert.strictEqual(yield* journal.recordTransient('epic-1'), 370_000);
			assert.strictEqual(yield* journal.recordTransient('epic-2'), 310_000);
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
	);

	it.effect('migrates an empty database file and reopens an already migrated one', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const filename = join(yield* fs.makeTempDirectoryScoped(), 'journal.db');

			yield* Journal.use((journal) => journal.putRun(followUp)).pipe(Effect.provide(Journal.layer(filename)));
			const reopened = yield* Journal.use((journal) => journal.listRuns).pipe(Effect.provide(Journal.layer(filename)));

			assert.deepStrictEqual(reopened, [followUp]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
