import { join } from 'node:path';
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
	job: { _tag: 'follow-up', threadIds: ['PRRT_1', 'PRRT_2'], instruction: 'Use the existing retry helper.' },
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

	it.effect('records a comment as a command once, and keeps when mentions were first read', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(42_000);

			const journal = yield* Layer.build(Journal.layer(':memory:')).pipe(Effect.map(Context.get(Journal)));
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
			yield* journal.putCommand({ ...first, status: 'running', claimedAt: 44_000, tabId: 'w1:t2', paneId: 'w1:p2' });
			assert.deepStrictEqual((yield* journal.listCommands).map(({ id, status, tabId }) => [id, status, tabId]), [
				[1, 'running', 'w1:t2'],
				[2, 'ignored', null],
			]);
			assert.strictEqual(yield* journal.mentionFloor, 42_000);
		}),
	);

	it.effect('keeps the first since of a mention thread until the thread is scanned', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;

			yield* journal.addMentionThread({ threadId: '18', repo: 'acme/web', number: 7, since: 2_000 });
			yield* journal.addMentionThread({ threadId: '18', repo: 'acme/web', number: 7, since: 9_000 });
			yield* journal.addMentionThread({ threadId: '19', repo: 'acme/api', number: 3, since: 1_000 });

			assert.deepStrictEqual(yield* journal.listMentionThreads(1), [{ threadId: '19', repo: 'acme/api', number: 3, since: 1_000 }]);

			yield* journal.deleteMentionThread('19');
			assert.deepStrictEqual(yield* journal.listMentionThreads(50), [{ threadId: '18', repo: 'acme/web', number: 7, since: 2_000 }]);
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

			assert.deepStrictEqual(reopened, [followUp]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
