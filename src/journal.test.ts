import { homedir } from 'node:os';
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
	replyTo: 'planning',
	claimedAt: 1_000,
	startedAt: null,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	tailHash: null,
	result: null,
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
	replyTo: null,
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
};

// The runs table as migrations 0001 to 0010 left it.
const runsBeforeNotices = `
	CREATE TABLE runs (
		epic_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, team_id TEXT NOT NULL, status TEXT NOT NULL, job TEXT NOT NULL, repo TEXT NOT NULL,
		branch TEXT NOT NULL, worktree_path TEXT, tab_id TEXT, pane_id TEXT, claimed_at INTEGER NOT NULL, started_at INTEGER, agent_status TEXT,
		agent_status_since INTEGER, nudged_at INTEGER, tail_hash TEXT, result TEXT, question_comment_id TEXT, delivered_reply_ids TEXT NOT NULL,
		session TEXT, reply_to TEXT
	);
`;

const migrationNames = [
	'create_journal',
	'drop_mention_threads',
	'create_delivery_mark',
	'add_sessions',
	'add_reply_to',
	'add_command_acknowledged_at',
	'create_chat_sessions',
	'create_topics',
	'create_projects',
	'add_chat_session_cwd_and_thread',
];

// A journal file whose migrations up to `applied` ran, holding only the tables `schema` makes.
const journalFileAt = (applied: number, schema: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const filename = join(yield* fs.makeTempDirectoryScoped(), 'journal.db');
		const database = new DatabaseSync(filename);

		database.exec(`
			CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL);
			${schema}
		`);

		for (const [id, name] of migrationNames.slice(0, applied).entries()) {
			database.prepare('INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)').run(id + 1, name);
		}

		database.close();

		return filename;
	});

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
				acknowledgedAt: null,
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

			yield* service.claimRun(claimed, [ask]);

			assert.deepStrictEqual(yield* cli.listRuns, [claimed]);
			assert.deepStrictEqual((yield* cli.listRequests).map(({ id }) => id), [stop]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('moves the chat sessions recorded before sessions had a directory to the main chat in the home directory, which they ran in', () =>
		Effect.gen(function* () {
			const filename = yield* journalFileAt(
				9,
				`${runsBeforeNotices}
				CREATE TABLE chat_sessions (message_ref TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
				INSERT INTO chat_sessions VALUES ('7100200300:12', 'session-a', 1000), ('7100200300:14', 'session-b', 2000);`,
			);
			const journal = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));

			assert.deepStrictEqual(yield* journal.chatSession('7100200300:12'), Option.some({ sessionId: 'session-a', cwd: homedir() }));
			assert.deepStrictEqual(yield* journal.latestChatSession, Option.some({ sessionId: 'session-b', cwd: homedir() }));
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('drops the question columns of runs recorded before notices', () =>
		Effect.gen(function* () {
			const filename = yield* journalFileAt(
				10,
				`${runsBeforeNotices}
				INSERT INTO runs (epic_id, identifier, team_id, status, job, repo, branch, claimed_at, question_comment_id, delivered_reply_ids, reply_to)
				VALUES ('epic-1', 'HL-9', 'team-1', 'claimed', '{"_tag":"orchestrate"}', '/home/dev/sapphire-agent', 'mario/hl-9-foundation', 1000, 'comment-9', '["reply-1"]', 'planning');`,
			);
			const journal = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));

			assert.deepStrictEqual(yield* journal.listRuns, [{ ...orchestrate, session: null }]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('keeps a notice in the outbox once per marker until it is sent', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;
			const stale = { marker: { identifier: 'HL-9', purpose: 'stale' as const, key: '1000-4000' }, text: '🔴 **HL-9 looks stuck**' };
			const summary = { marker: { identifier: 'HL-9', purpose: 'summary' as const, key: '1000' }, text: '✅ **HL-9 is ready for review**' };

			yield* journal.addNotice(stale);
			yield* journal.addNotice(summary);
			yield* journal.addNotice({ ...stale, text: 'written again' });

			const unsent = yield* journal.unsentNotices;

			assert.deepStrictEqual(
				unsent.map(({ identifier, purpose, key, text }) => ({ marker: { identifier, purpose, key }, text })),
				[stale, summary],
			);

			yield* journal.markNoticeSent(unsent[0].id);
			yield* journal.addNotice(stale);

			assert.deepStrictEqual((yield* journal.unsentNotices).map(({ purpose }) => purpose), ['summary']);
			assert.isTrue(yield* journal.hasNotice(stale.marker));
			assert.isFalse(yield* journal.hasNotice({ ...stale.marker, key: '1000-9000' }));
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
	);

	it.effect("keeps the main chat's newest session apart from a project thread's newest bot message", () =>
		Effect.gen(function* () {
			const journal = yield* Journal;

			yield* journal.addChatSession(['1:2'], { sessionId: 'main', cwd: '/home/dev', thread: null, kind: 'turn' });
			yield* TestClock.setTime(5_000);
			yield* journal.addChatSession(['1:4:3', '1:5:3'], { sessionId: 'project', cwd: '/home/dev/hivemind', thread: '1:3', kind: 'turn' });

			assert.deepStrictEqual(yield* journal.latestChatSession, Option.some({ sessionId: 'main', cwd: '/home/dev' }));
			assert.deepStrictEqual(
				yield* journal.lastChatMessage('1:3'),
				Option.some({ messageRef: '1:5:3', sessionId: 'project', cwd: '/home/dev/hivemind', thread: '1:3', kind: 'turn' as const, createdAt: 5_000 }),
			);
			assert.deepStrictEqual(yield* journal.lastChatMessage('1:9'), Option.none());
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
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
				['archive_thread', 'chat_sessions', 'commands', 'delivery_mark', 'effect_sql_migrations', 'notices', 'projects', 'requests', 'runs', 'topics', 'transient_failures'],
			);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
