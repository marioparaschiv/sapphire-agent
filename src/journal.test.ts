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
	session: { id: '0d5c1a3e-6f0b-4c8e-9d2a-7b1e4f3a9c60', name: 'hl-9' },
	replyTo: 'planning',
	claimedAt: 1_000,
	startedAt: null,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	result: null,
	handoff: null,
	threadId: null,
	threadRunId: null,
	threadSettledAt: null,
};

const followUp: Run = {
	epicId: 'epic-2',
	identifier: 'HL-10',
	teamId: 'team-1',
	status: 'stale',
	job: { _tag: 'follow-up', threadIds: ['PRRT_1', 'PRRT_2'], instruction: 'Use the existing retry helper.' },
	repo: '/home/dev/unbound-app/loader-ios',
	branch: 'mario/hl-10-linear',
	worktreePath: '/home/dev/.t3/worktrees/loader-ios/mario-hl-10-linear',
	session: { id: '5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35', name: 'hl-10' },
	replyTo: null,
	claimedAt: 500,
	startedAt: 2_000,
	agentStatus: 'blocked',
	agentStatusSince: 3_000,
	nudgedAt: 4_000,
	result: {
		summary: 'Added the Linear service.',
		replies: [{ threadId: 'PRRT_1', body: 'Fixed.' }],
		flags: [{ path: 'src/linear.ts', line: 12, body: 'Check the page size.' }],
	},
	handoff: { sessionId: '5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35', step: 'requested' },
	threadId: '0d3b6f2a-8c41-4e7d-9a5b-1f2e3d4c5b6a',
	threadRunId: 'run:thread:0d3b6f2a-8c41-4e7d-9a5b-1f2e3d4c5b6a:ordinal:1',
	threadSettledAt: 9_000,
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
	'create_notices',
	'add_handoffs',
	'drop_chat',
	'create_t3_projects',
	'add_threads',
	'add_thread_settling_and_command_threads',
];

// The commands table, with only the columns later migrations change.
const commandsTable = `
	CREATE TABLE commands (
		id INTEGER PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, tab_id TEXT, pane_id TEXT, session TEXT, agent_status TEXT, agent_status_since INTEGER,
		nudged_at INTEGER, tail_hash TEXT
	);
`;

// The tables the chat left, which a later migration drops, and the requests and projects it changes.
const chatTables = `
	CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL, created_at INTEGER NOT NULL);
	CREATE TABLE delivery_mark (id INTEGER PRIMARY KEY CHECK (id = 1), delivered_at INTEGER NOT NULL);
	CREATE TABLE chat_sessions (message_ref TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, thread TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
	CREATE TABLE topics (epic_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, thread TEXT NOT NULL, state TEXT NOT NULL, pull_request_url TEXT, milestones TEXT NOT NULL);
	CREATE TABLE archive_thread (id INTEGER PRIMARY KEY CHECK (id = 1), thread TEXT NOT NULL);
	CREATE TABLE projects (team TEXT PRIMARY KEY, repo TEXT NOT NULL, label_repos_directory TEXT, thread TEXT);
`;

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

			const running: Run = { ...orchestrate, status: 'running', startedAt: 1_500, agentStatus: 'working', agentStatusSince: 1_500, threadId: 'f2c8a417-5d3e-4b9a-8c61-7e0d2b4f9a13' };

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
				recordedAt: 43_000,
				claimedAt: null,
				startedAt: null,
				acknowledgedAt: null,
				threadId: null,
			};

			yield* journal.addCommand(mention);
			yield* journal.addCommand({ ...mention, body: 'edited', status: 'ignored' });
			yield* journal.addCommand({ ...mention, commentId: 'IC_kwDO2', status: 'ignored' });

			const [first, second] = yield* journal.listCommands;

			assert.deepStrictEqual([first, second], [
				{ id: 1, ...mention },
				{ id: 2, ...mention, commentId: 'IC_kwDO2', status: 'ignored' },
			]);
			yield* journal.putCommand({ ...first, status: 'running', claimedAt: 44_000, threadId: '9e4f7a21-3b6c-4d8e-a15f-0c2b8d7e6a43' });
			assert.deepStrictEqual((yield* journal.listCommands).map(({ id, status, threadId }) => [id, status, threadId]), [
				[1, 'running', '9e4f7a21-3b6c-4d8e-a15f-0c2b8d7e6a43'],
				[2, 'ignored', null],
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

	it.effect("drops the chat's tables, the projects' threads, the phase requests and the command notices the chat never sent", () =>
		Effect.gen(function* () {
			const filename = yield* journalFileAt(
				12,
				`${runsBeforeNotices}
				${chatTables}
				${commandsTable}
				ALTER TABLE runs DROP COLUMN question_comment_id;
				ALTER TABLE runs DROP COLUMN delivered_reply_ids;
				ALTER TABLE runs ADD COLUMN handoff TEXT;
				CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, identifier TEXT NOT NULL, purpose TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (identifier, purpose, key));
				CREATE TABLE subagent_handoffs (agent_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, requested_at INTEGER NOT NULL);
				INSERT INTO projects VALUES ('Unbound', '/home/dev/unbound', NULL, '7100200300:3');
				INSERT INTO requests (request, created_at) VALUES ('{"_tag":"phase","identifier":"HL-9","phase":"sreview"}', 1000), ('{"_tag":"stop","identifier":"HL-9"}', 2000);
				INSERT INTO notices (identifier, purpose, key, text, created_at) VALUES ('CMD-3', 'commandReply', '7', 'Stopped HL-9.', 1000), ('HL-9', 'stale', '1000-4000', 'HL-9 looks stuck', 2000);`,
			);
			const journal = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));
			const database = new DatabaseSync(filename, { readOnly: true });
			const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chat_sessions', 'topics', 'archive_thread', 'delivery_mark')`).all();

			database.close();
			assert.deepStrictEqual(tables, []);
			assert.deepStrictEqual(yield* journal.listProjects, [{ team: 'Unbound', repo: '/home/dev/unbound', labelReposDirectory: null }]);
			assert.deepStrictEqual((yield* journal.listRequests).map(({ request }) => request), [{ _tag: 'stop', identifier: 'HL-9' }]);
			assert.deepStrictEqual((yield* journal.unsentNotices).map(({ identifier }) => identifier), ['HL-9']);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('drops the question columns of runs recorded before notices', () =>
		Effect.gen(function* () {
			const filename = yield* journalFileAt(
				10,
				`${runsBeforeNotices}
				${chatTables}
				${commandsTable}
				INSERT INTO runs (epic_id, identifier, team_id, status, job, repo, branch, claimed_at, question_comment_id, delivered_reply_ids, reply_to)
				VALUES ('epic-1', 'HL-9', 'team-1', 'claimed', '{"_tag":"orchestrate"}', '/home/dev/sapphire-agent', 'mario/hl-9-foundation', 1000, 'comment-9', '["reply-1"]', 'planning');`,
			);
			const journal = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));

			assert.deepStrictEqual(yield* journal.listRuns, [{ ...orchestrate, session: null }]);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('drops the tab columns, keeping the runs and commands recorded before readable', () =>
		Effect.gen(function* () {
			const filename = yield* journalFileAt(
				16,
				`CREATE TABLE runs (
					epic_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, team_id TEXT NOT NULL, status TEXT NOT NULL, job TEXT NOT NULL, repo TEXT NOT NULL,
					branch TEXT NOT NULL, worktree_path TEXT, tab_id TEXT, pane_id TEXT, claimed_at INTEGER NOT NULL, started_at INTEGER, agent_status TEXT,
					agent_status_since INTEGER, nudged_at INTEGER, tail_hash TEXT, result TEXT, session TEXT, reply_to TEXT, handoff TEXT, thread_id TEXT,
					thread_run_id TEXT, thread_settled_at INTEGER
				);
				CREATE TABLE commands (
					id INTEGER PRIMARY KEY, comment_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL,
					number INTEGER NOT NULL, status TEXT NOT NULL, cwd TEXT, tab_id TEXT, pane_id TEXT, recorded_at INTEGER NOT NULL, claimed_at INTEGER,
					started_at INTEGER, agent_status TEXT, agent_status_since INTEGER, nudged_at INTEGER, tail_hash TEXT, session TEXT, acknowledged_at INTEGER,
					thread_id TEXT
				);
				CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, identifier TEXT NOT NULL, purpose TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (identifier, purpose, key));
				INSERT INTO runs VALUES (
					'epic-2', 'HL-10', 'team-1', 'awaitingInput', '{"_tag":"orchestrate"}', '/home/dev/unbound-app/loader-ios', 'mario/hl-10-linear',
					'/home/dev/.t3/worktrees/loader-ios/mario-hl-10-linear', 'w1:t3', 'w1:p7', 500, 2000, 'exited', 3000, NULL, 'f3a1', NULL,
					'{"id":"5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35","name":"hl-10"}', NULL, '{"sessionId":"5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35","step":"cleared"}',
					NULL, NULL, NULL
				);
				INSERT INTO runs VALUES (
					'epic-1', 'HL-9', 'team-1', 'running', '{"_tag":"orchestrate"}', '/home/dev/sapphire-agent', 'mario/hl-9-foundation', NULL, NULL, NULL, 1000,
					1500, 'working', 1500, NULL, NULL, NULL, '{"id":"0d5c1a3e-6f0b-4c8e-9d2a-7b1e4f3a9c60","name":"hl-9"}', 'planning', NULL,
					'f2c8a417-5d3e-4b9a-8c61-7e0d2b4f9a13', 'run:thread:f2c8a417-5d3e-4b9a-8c61-7e0d2b4f9a13:ordinal:1', NULL
				);
				INSERT INTO commands VALUES (
					1, 'IC_kwDO1', 'https://github.com/acme/web/pull/7#issuecomment-1', 'marioparaschiv', '@orchestratorbot stop HL-12', 'acme/web', 7, 'ended',
					'/home/dev/sapphire-agent', 'w1:t2', 'w1:p2', 43000, 44000, 45000, 'idle', 46000, NULL, 'c0de', '{"id":"9e4f7a21-3b6c-4d8e-a15f-0c2b8d7e6a43","name":"cmd-1"}',
					44500, NULL
				);
				INSERT INTO notices (identifier, purpose, key, text, created_at) VALUES
					('HL-10', 'workingOrphan', 'w1:t3', 'An untracked agent works on HL-10', 1000),
					('HL-10', 'awaitingInput', '500-3000', 'HL-10 needs input', 2000),
					('HL-9', 'stale', '1000-4000', 'HL-9 looks stuck', 3000);`,
			);
			const journal = yield* Layer.build(Journal.layer(filename)).pipe(Effect.map(Context.get(Journal)));

			assert.deepStrictEqual(yield* journal.listRuns, [
				{
					...orchestrate,
					epicId: 'epic-2',
					identifier: 'HL-10',
					status: 'running',
					repo: '/home/dev/unbound-app/loader-ios',
					branch: 'mario/hl-10-linear',
					worktreePath: '/home/dev/.t3/worktrees/loader-ios/mario-hl-10-linear',
					session: { id: '5b8e2f47-1c3d-4a9e-8f60-2d7c9b1a4e35', name: 'hl-10' },
					replyTo: null,
					claimedAt: 500,
					startedAt: 2_000,
					agentStatusSince: 3_000,
				},
				{
					...orchestrate,
					status: 'running',
					startedAt: 1_500,
					agentStatus: 'working',
					agentStatusSince: 1_500,
					threadId: 'f2c8a417-5d3e-4b9a-8c61-7e0d2b4f9a13',
					threadRunId: 'run:thread:f2c8a417-5d3e-4b9a-8c61-7e0d2b4f9a13:ordinal:1',
				},
			]);
			assert.deepStrictEqual(yield* journal.listCommands, [
				{
					id: 1,
					commentId: 'IC_kwDO1',
					url: 'https://github.com/acme/web/pull/7#issuecomment-1',
					author: 'marioparaschiv',
					body: '@orchestratorbot stop HL-12',
					repo: 'acme/web',
					number: 7,
					status: 'ended',
					cwd: '/home/dev/sapphire-agent',
					recordedAt: 43_000,
					claimedAt: 44_000,
					startedAt: 45_000,
					acknowledgedAt: 44_500,
					threadId: null,
				},
			]);
			assert.deepStrictEqual((yield* journal.unsentNotices).map(({ purpose }) => purpose), ['stale']);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('keeps a notice in the outbox once per marker until it is sent', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;
			const stale = { marker: { identifier: 'HL-9', purpose: 'stale' as const, key: '1000-4000' }, text: '🔴 **HL-9 looks stuck**' };
			const summary = { marker: { identifier: 'HL-9', purpose: 'summary' as const, key: '1000' }, text: '✅ **HL-9 is ready for review**' };

			assert.deepStrictEqual([yield* journal.addNotice(stale), yield* journal.addNotice(summary), yield* journal.addNotice({ ...stale, text: 'written again' })], [true, true, false]);

			const unsent = yield* journal.unsentNotices;

			assert.deepStrictEqual(
				unsent.map(({ identifier, purpose, key, text }) => ({ marker: { identifier, purpose, key }, text })),
				[stale, summary],
			);

			yield* journal.markNoticeSent(unsent[0].id);
			assert.isFalse(yield* journal.addNotice(stale));

			assert.deepStrictEqual((yield* journal.unsentNotices).map(({ purpose }) => purpose), ['summary']);
			assert.isTrue(yield* journal.hasNotice(stale.marker));
			assert.isFalse(yield* journal.hasNotice({ ...stale.marker, key: '1000-9000' }));
		}).pipe(Effect.provide(Journal.layer(':memory:'))),
	);

	it.effect('remembers the T3 project of each repo, a later one replacing it', () =>
		Effect.gen(function* () {
			const journal = yield* Journal;

			yield* journal.putT3Project({ repo: '/home/dev/unbound', projectId: '599d8e00-4dc0-4c36-aa38-4ebb6c02bad5' });
			yield* journal.putT3Project({ repo: '/home/dev/telecord', projectId: '1975f15c-daea-4ef5-92e8-4854c122d672' });
			yield* journal.putT3Project({ repo: '/home/dev/unbound', projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd' });

			assert.deepStrictEqual(yield* journal.getT3Project('/home/dev/unbound'), Option.some('8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd'));
			assert.deepStrictEqual(yield* journal.getT3Project('/home/dev/telecord'), Option.some('1975f15c-daea-4ef5-92e8-4854c122d672'));
			assert.deepStrictEqual(yield* journal.getT3Project('/home/dev/hivemind.ts'), Option.none());
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
				['commands', 'effect_sql_migrations', 'notices', 'projects', 'requests', 'runs', 'subagent_handoffs', 't3_projects', 'transient_failures'],
			);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
