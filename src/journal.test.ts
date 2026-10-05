import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, FileSystem, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Journal, type NewCommand, type Run } from './journal.ts';

const orchestrate: Run = {
	epicId: 'epic-1',
	identifier: 'HL-9',
	teamId: 'team-1',
	status: 'claimed',
	job: { _tag: 'orchestrate' },
	repo: '/home/dev/sapphire-agent',
	branch: 'mario/hl-9-foundation',
	worktreePath: null,
	tabId: null,
	paneId: null,
	session: { id: '0d5c1a3e-6f0b-4c8e-9d2a-7b1e4f3a9c60', name: 'hl-9' },
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
	job: { _tag: 'follow-up', threadIds: ['PRRT_1', 'PRRT_2'], instruction: 'Use the existing retry helper.' },
	repo: '/home/dev/unbound-app/loader-ios',
	branch: 'mario/hl-10-linear',
	worktreePath: '/home/dev/.herdr/worktrees/loader-ios/mario-hl-10-linear',
	tabId: 'w1:t3',
	paneId: 'w1:p7',
	session: { id: '5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35', name: 'hl-10' },
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

	it.effect('records a comment as a command once', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;
			const mention: NewCommand = {
				commentId: 'IC_kwDO1',
				url: 'https://github.com/acme/web/pull/7#issuecomment-1',
				author: 'marioparaschiv',
				body: '@orchestratorbot stop HL-12',
				repo: 'acme/web',
				number: 7,
				status: 'queued',
				cwd: null,
				tabId: null,
				paneId: null,
				session: null,
				recordedAt: 43_000,
				claimedAt: null,
				startedAt: null,
				agentStatus: null,
				agentStatusSince: null,
				nudgedAt: null,
				tailHash: null,
			};

			yield* journal.addCommand(mention);
			yield* journal.addCommand({ ...mention, body: 'edited', status: 'ignored' });
			yield* journal.addCommand({ ...mention, commentId: 'IC_kwDO2', status: 'ignored' });

			const [first, second] = yield* journal.listCommands;

			assert.deepStrictEqual([first, second], [
				{ id: 1, ...mention },
				{ id: 2, ...mention, commentId: 'IC_kwDO2', status: 'ignored' },
			]);
			yield* journal.putCommand({ ...first, status: 'running', claimedAt: 44_000, tabId: 'w1:t2', paneId: 'w1:p2', session: { id: '9e4f7a21-3b6c-4d8e-a15f-0c2b8d7e6a43', name: 'cmd-1' } });
			assert.deepStrictEqual((yield* journal.listCommands).map(({ id, status, tabId, session }) => [id, status, tabId, session]), [
				[1, 'running', 'w1:t2', { id: '9e4f7a21-3b6c-4d8e-a15f-0c2b8d7e6a43', name: 'cmd-1' }],
				[2, 'ignored', null, null],
			]);
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
	);

	it.effect("sees the requests another process appends while it has the file open, and claims a follow-up and drops its request together", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const filename = join(yield* fs.makeTempDirectoryScoped(), 'journal.db');
			const service = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));
			const cli = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));
			const ended: Run = { ...followUp, status: 'ended' };

			yield* service.putRun(ended);
			yield* TestClock.setTime(7_000);

			const stop = yield* cli.addRequest({ _tag: 'stop', identifier: 'HL-9' });
			const ask = yield* cli.addRequest({ _tag: 'follow-up', identifier: 'HL-10', instruction: 'Use the existing retry helper.', threadIds: [] });

			assert.deepStrictEqual(yield* service.listRequests, [
				{ id: stop, request: { _tag: 'stop', identifier: 'HL-9' }, createdAt: 7_000 },
				{ id: ask, request: { _tag: 'follow-up', identifier: 'HL-10', instruction: 'Use the existing retry helper.', threadIds: [] }, createdAt: 7_000 },
			]);

			const claimed: Run = { ...ended, status: 'claimed', job: { _tag: 'follow-up', threadIds: [], instruction: 'Use the existing retry helper.' }, claimedAt: 7_000 };

			yield* service.claimFollowUp(claimed, ask);

			assert.deepStrictEqual(yield* cli.listRuns, [claimed]);
			assert.deepStrictEqual((yield* cli.listRequests).map(({ id }) => id), [stop]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('migrates an empty database file and reopens an already migrated one', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const filename = join(yield* fs.makeTempDirectoryScoped(), 'journal.db');

			yield* Journal.use((journal) => journal.putRun(followUp)).pipe(Effect.provide(Journal.layer(filename)));
			const reopened = yield* Journal.use((journal) => journal.listRuns).pipe(Effect.provide(Journal.layer(filename)));
			const database = new DatabaseSync(filename, { readOnly: true });
			const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();

			database.close();
			assert.deepStrictEqual(reopened, [followUp]);
			assert.deepStrictEqual(
				tables.map(({ name }) => name),
				['commands', 'delivery_mark', 'effect_sql_migrations', 'requests', 'runs', 'transient_failures'],
			);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
