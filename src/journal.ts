import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Clock, Context, Effect, Layer, Option, Schema, String } from 'effect';
import { SqlClient, type SqlError, SqlSchema } from 'effect/sql';
import { AgentName } from './agent-event.ts';
import { Marker, type Notice } from './markers.ts';
import { ResultFile } from './result-file.ts';

// claimed: recorded before the run is started. running: its T3 thread was launched. stale: the thread showed no
// progress even after a nudge. error: the result could not be posted, or the run never started. ended: the run is
// over; the worktree stays until the epic ships or its PR is merged or closed. kept: cleanup found work that is not on
// origin, so the worktree stays.
export const RunStatus = Schema.Literals(['claimed', 'running', 'stale', 'error', 'ended', 'kept']);

export type RunStatus = typeof RunStatus.Type;

// blocked: a question or approval waits for the user.
export const AgentStatus = Schema.Literals(['working', 'idle', 'blocked']);

export type AgentStatus = typeof AgentStatus.Type;

// A follow-up run answers the review threads and carries out the instruction its request named.
export const Job = Schema.Union([
	Schema.TaggedStruct('orchestrate', {}),
	Schema.TaggedStruct('follow-up', { threadIds: Schema.Array(Schema.String), instruction: Schema.NullOr(Schema.String) }),
]);

export type Job = typeof Job.Type;

const Millis = Schema.Int;

// The Claude session an agent runs in. Other Claude sessions on the machine message it by name.
export const Session = Schema.Struct({ id: Schema.String, name: Schema.String });

export type Session = typeof Session.Type;

export const sessionName = (identifier: string) => identifier.toLowerCase();

// Made when a run is claimed; the agent event server replaces the id with the session the agent runs in.
export const newSession = (identifier: string) => Effect.sync((): Session => ({ id: randomUUID(), name: sessionName(identifier) }));

// The run's agent handing its work to a fresh thread once its context filled up: asked to write the handoff doc, then,
// once the doc exists and the thread stopped, a new thread told to read it. Each step is recorded before it is sent, so
// none is sent twice.
export const HandoffStep = Schema.Literals(['requested', 'resumed']);

// `sessionId` is the session that hands off.
export const Handoff = Schema.Struct({ sessionId: Schema.String, step: HandoffStep });

export type Handoff = typeof Handoff.Type;

// Only what cannot be observed from Linear, T3, git or GitHub. Times are epoch milliseconds.
export const Run = Schema.Struct({
	epicId: Schema.String,
	identifier: Schema.String,
	teamId: Schema.String,
	status: RunStatus,
	job: Schema.fromJsonString(Job),
	// The local clone the worktree is made from.
	repo: Schema.String,
	branch: Schema.String,
	worktreePath: Schema.NullOr(Schema.String),
	// None for a run claimed before sessions were recorded.
	session: Schema.NullOr(Schema.fromJsonString(Session)),
	// The Claude session that asked for the run (`ctl.sh dispatch --reply-to`), which its agent asks its questions. None asks on Linear.
	replyTo: Schema.NullOr(Schema.String),
	claimedAt: Millis,
	// When its T3 thread was launched.
	startedAt: Schema.NullOr(Millis),
	agentStatus: Schema.NullOr(AgentStatus),
	// When the thread, its timeline, its subagents or the agent's hook events last showed progress.
	agentStatusSince: Schema.NullOr(Millis),
	// When the current stale episode's nudge was sent; cleared once the agent acts again.
	nudgedAt: Schema.NullOr(Millis),
	result: Schema.NullOr(Schema.fromJsonString(ResultFile)),
	// The latest handoff; none before the first.
	handoff: Schema.NullOr(Schema.fromJsonString(Handoff)),
	// The run's T3 thread and the run of that thread it started; none until the launch.
	threadId: Schema.NullOr(Schema.String),
	threadRunId: Schema.NullOr(Schema.String),
	// When cleanup settled the run's thread, or found T3 had. Found un-settled after that, the user un-settled it.
	threadSettledAt: Schema.NullOr(Millis),
});

export type Run = typeof Run.Type;

// ignored: the comment's author is not in bot.allowedUsers, so nothing runs. queued: waiting for its turn, as commands
// run one at a time. claimed: its turn came and it is being started. running: its T3 thread was launched. ended: the
// agent said it was done and its thread is settled. error: it failed to start, lost its thread, went quiet without
// saying it was done, or ran over the cap; the comment it answers got a reply saying so and its thread is settled.
export const CommandStatus = Schema.Literals(['ignored', 'queued', 'claimed', 'running', 'ended', 'error']);

export type CommandStatus = typeof CommandStatus.Type;

// A comment that mentions the bot, recorded before anything else happens for it, so it is handled at most once.
export const NewCommand = Schema.Struct({
	// The GitHub node id of the comment.
	commentId: Schema.String,
	url: Schema.String,
	author: Schema.String,
	body: Schema.String,
	// The issue or PR the comment is on, as `owner/name` and its number.
	repo: Schema.String,
	number: Schema.Int,
	status: CommandStatus,
	// The checkout the agent runs in, once made.
	cwd: Schema.NullOr(Schema.String),
	recordedAt: Millis,
	// When its turn came. Keys its markers, starts its start timeout and its wall-clock cap.
	claimedAt: Schema.NullOr(Millis),
	startedAt: Schema.NullOr(Millis),
	// When the comment got the App's thumbs-up, which tells its author the bot has it before any reply.
	acknowledgedAt: Schema.NullOr(Millis),
	// The T3 thread the command runs in; none until the launch.
	threadId: Schema.NullOr(Schema.String),
});

export type NewCommand = typeof NewCommand.Type;

// `id` numbers commands in the order their comments were seen; `CMD-<id>` names one in logs, markers and the CLI.
export const Command = Schema.Struct({ id: Schema.Int, ...NewCommand.fields });

export type Command = typeof Command.Type;

export const commandIdentifier = (command: Pick<Command, 'id'>) => `CMD-${command.id}`;

// A Linear team sapphire-agent watches, by its exact name, and the local clone its epics run in.
export const Project = Schema.Struct({
	team: Schema.String,
	repo: Schema.String,
	// An epic labelled `<repoPrefix><name>` runs in `<labelReposDirectory>/<name>` instead of `repo`.
	labelReposDirectory: Schema.NullOr(Schema.String),
});

export type Project = typeof Project.Type;

// What `scripts/ctl.sh` and the agent event server ask the reconciler to do on its next tick. Both only append these,
// so they never race a rule over a row; the rule that acts on one deletes it.
export const Request = Schema.Union([
	Schema.TaggedStruct('start', { identifier: Schema.String, replyTo: Schema.NullOr(Schema.String) }),
	Schema.TaggedStruct('stop', { identifier: Schema.String }),
	Schema.TaggedStruct('send', { identifier: Schema.String, text: Schema.String }),
	Schema.TaggedStruct('follow-up', { identifier: Schema.String, instruction: Schema.NullOr(Schema.String), threadIds: Schema.Array(Schema.String) }),
	Schema.TaggedStruct('reply', { commandId: Schema.Int, body: Schema.String }),
	Schema.TaggedStruct('done', { commandId: Schema.Int }),
	// Recorded by the agent event server when a run's agent starts another session.
	Schema.TaggedStruct('session', { identifier: Schema.String, sessionId: Schema.String }),
	// Recorded by the agent event server when a run's agent's context reached handoffAtTokens in that session; `agent`
	// is the agent whose event it was, recorded before there was one but Claude.
	Schema.TaggedStruct('handoff', { identifier: Schema.String, sessionId: Schema.String, agent: AgentName.pipe(Schema.withDecodingDefaultKey(Effect.succeed('claude'))) }),
	// `sapphire project add`, `edit` and `remove`, checked by the CLI before they are recorded.
	Schema.TaggedStruct('project-add', { project: Project }),
	Schema.TaggedStruct('project-edit', { project: Project }),
	Schema.TaggedStruct('project-remove', { team: Schema.String }),
]);

export type Request = typeof Request.Type;

export const RequestRow = Schema.Struct({ id: Schema.Int, request: Schema.fromJsonString(Request), createdAt: Millis });

export type RequestRow = typeof RequestRow.Type;

// A notice in the outbox, oldest first, until the notices rule posted it.
export const UnsentNotice = Schema.Struct({ id: Schema.Int, ...Marker.fields, text: Schema.String });

export type UnsentNotice = typeof UnsentNotice.Type;

export const SubagentHandoff = Schema.Struct({ agentId: Schema.String, identifier: Schema.String });

export type SubagentHandoff = typeof SubagentHandoff.Type;

// The T3 project a local clone was found or created as.
const T3ProjectRow = Schema.Struct({ repo: Schema.String, projectId: Schema.String });

type T3ProjectRow = typeof T3ProjectRow.Type;

// An issue of a run's epic, the epic itself or a sub-issue, as the epic-edits rule last compared it. Labels and blockers
// are sorted names and identifiers.
export const IssueSnapshot = Schema.Struct({
	id: Schema.String,
	identifier: Schema.String,
	title: Schema.String,
	description: Schema.String,
	state: Schema.String,
	labels: Schema.Array(Schema.String),
	blockedBy: Schema.Array(Schema.String),
});

export type IssueSnapshot = typeof IssueSnapshot.Type;

export const EditedField = Schema.Literals(['title', 'description', 'state', 'labels', 'blockedBy', 'subIssue']);

export type EditedField = typeof EditedField.Type;

// One field of one issue that changed since the snapshot. A sub-issue that was added has `before` null, one that was
// removed `after` null, each with its title. Labels and blockers are comma-separated; none is null.
export const EpicEdit = Schema.Struct({
	issueId: Schema.String,
	identifier: Schema.String,
	field: EditedField,
	before: Schema.NullOr(Schema.String),
	after: Schema.NullOr(Schema.String),
});

export type EpicEdit = typeof EpicEdit.Type;

// What an in-flight run's agent knows of its epic and sub-issues: as they were at the claim, or when the agent was last
// told of edits to them.
export const EpicSnapshot = Schema.Struct({
	epicId: Schema.String,
	// The claim of the run it was taken for; a later claim of the epic takes its own.
	claimedAt: Millis,
	// When Linear was read for it. Linear's history since then says who made an edit.
	takenAt: Millis,
	// The epic first.
	issues: Schema.fromJsonString(Schema.Array(IssueSnapshot)),
	// The edits by others not yet sent, and when they last changed; none while there are none.
	edits: Schema.NullOr(Schema.fromJsonString(Schema.Array(EpicEdit))),
	editedAt: Schema.NullOr(Millis),
});

export type EpicSnapshot = typeof EpicSnapshot.Type;

export type JournalError = SqlError.SqlError | Schema.SchemaError;

export const journalPath = (stateDirectory: string) => join(stateDirectory, 'journal.db');

const clientLayer = (filename: string, options: { readonly readonly?: boolean } = {}) =>
	SqliteClient.layer({ filename, ...options, transformQueryNames: String.camelToSnake, transformResultNames: String.snakeToCamel });

const selectProjects = (sql: SqlClient.SqlClient) =>
	SqlSchema.findAll({
		Request: Schema.Void,
		Result: Project,
		execute: () => sql`SELECT * FROM projects ORDER BY team`,
	})(undefined);

// The projects as the service last wrote them, read without migrating, by a process beside it (the run hooks).
export const readProjects = (filename: string) => SqlClient.SqlClient.pipe(Effect.flatMap(selectProjects), Effect.provide(clientLayer(filename, { readonly: true })));

const migrations = SqliteMigrator.layer({
	loader: SqliteMigrator.fromRecord({
		'0001_create_journal': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`
				CREATE TABLE runs (
					epic_id TEXT PRIMARY KEY,
					identifier TEXT NOT NULL,
					team_id TEXT NOT NULL,
					status TEXT NOT NULL,
					job TEXT NOT NULL,
					repo TEXT NOT NULL,
					branch TEXT NOT NULL,
					worktree_path TEXT,
					tab_id TEXT,
					pane_id TEXT,
					claimed_at INTEGER NOT NULL,
					started_at INTEGER,
					agent_status TEXT,
					agent_status_since INTEGER,
					nudged_at INTEGER,
					tail_hash TEXT,
					result TEXT,
					question_comment_id TEXT,
					delivered_reply_ids TEXT NOT NULL
				)
			`;
			yield* sql`
				CREATE TABLE transient_failures (
					epic_id TEXT PRIMARY KEY,
					first_seen_at INTEGER NOT NULL
				)
			`;
			yield* sql`
				CREATE TABLE commands (
					id INTEGER PRIMARY KEY,
					comment_id TEXT NOT NULL UNIQUE,
					url TEXT NOT NULL,
					author TEXT NOT NULL,
					body TEXT NOT NULL,
					repo TEXT NOT NULL,
					number INTEGER NOT NULL,
					status TEXT NOT NULL,
					cwd TEXT,
					tab_id TEXT,
					pane_id TEXT,
					recorded_at INTEGER NOT NULL,
					claimed_at INTEGER,
					started_at INTEGER,
					agent_status TEXT,
					agent_status_since INTEGER,
					nudged_at INTEGER,
					tail_hash TEXT
				)
			`;
			yield* sql`
				CREATE TABLE mention_threads (
					thread_id TEXT PRIMARY KEY,
					repo TEXT NOT NULL,
					number INTEGER NOT NULL,
					since INTEGER NOT NULL
				)
			`;
			// Mentions written before the journal existed are never run.
			yield* sql`CREATE TABLE mention_floor (since INTEGER NOT NULL)`;
			yield* sql`INSERT INTO mention_floor (since) VALUES (${yield* Clock.currentTimeMillis})`;
			// AUTOINCREMENT never hands out an id again, since a reply's marker is keyed by its request's id.
			yield* sql`
				CREATE TABLE requests (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					request TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`;
		}),
		'0002_drop_mention_threads': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`DROP TABLE mention_threads`;
			yield* sql`DROP TABLE mention_floor`;
		}),
		'0003_create_delivery_mark': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// At most one row.
			yield* sql`
				CREATE TABLE delivery_mark (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					delivered_at INTEGER NOT NULL
				)
			`;
		}),
		'0004_add_sessions': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs ADD COLUMN session TEXT`;
			yield* sql`ALTER TABLE commands ADD COLUMN session TEXT`;
		}),
		'0005_add_reply_to': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs ADD COLUMN reply_to TEXT`;
		}),
		'0006_add_command_acknowledged_at': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE commands ADD COLUMN acknowledged_at INTEGER`;
		}),
		'0007_create_chat_sessions': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// The Claude session each bot message of the main chat was written in; a reply to the message forks it.
			yield* sql`
				CREATE TABLE chat_sessions (
					message_ref TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`;
		}),
		'0008_create_topics': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`
				CREATE TABLE topics (
					epic_id TEXT PRIMARY KEY,
					identifier TEXT NOT NULL,
					thread TEXT NOT NULL,
					state TEXT NOT NULL,
					pull_request_url TEXT,
					milestones TEXT NOT NULL
				)
			`;
			// At most one row: the thread shipped epics are summed up in.
			yield* sql`
				CREATE TABLE archive_thread (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					thread TEXT NOT NULL
				)
			`;
		}),
		'0009_create_projects': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`
				CREATE TABLE projects (
					team TEXT PRIMARY KEY,
					repo TEXT NOT NULL,
					label_repos_directory TEXT,
					thread TEXT
				)
			`;
		}),
		'0010_add_chat_session_cwd_and_thread': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// Every chat turn so far ran in the home directory, in the main chat.
			yield* sql`
				CREATE TABLE chat_messages (
					message_ref TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					cwd TEXT NOT NULL,
					thread TEXT,
					kind TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`;
			yield* sql`
				INSERT INTO chat_messages (message_ref, session_id, cwd, thread, kind, created_at)
				SELECT message_ref, session_id, ${homedir()}, NULL, 'turn', created_at FROM chat_sessions ORDER BY rowid
			`;
			yield* sql`DROP TABLE chat_sessions`;
			yield* sql`ALTER TABLE chat_messages RENAME TO chat_sessions`;
		}),
		'0011_create_notices': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// Sent notices stay, so a notice written again for the same marker is not sent again.
			yield* sql`
				CREATE TABLE notices (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					identifier TEXT NOT NULL,
					purpose TEXT NOT NULL,
					key TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					sent_at INTEGER,
					UNIQUE (identifier, purpose, key)
				)
			`;
			yield* sql`ALTER TABLE runs DROP COLUMN question_comment_id`;
			yield* sql`ALTER TABLE runs DROP COLUMN delivered_reply_ids`;
		}),
		'0012_add_handoffs': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs ADD COLUMN handoff TEXT`;
			// The subagents told to hand off, so each is told once.
			yield* sql`
				CREATE TABLE subagent_handoffs (
					agent_id TEXT PRIMARY KEY,
					identifier TEXT NOT NULL,
					requested_at INTEGER NOT NULL
				)
			`;
		}),
		'0013_drop_chat': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`DROP TABLE chat_sessions`;
			yield* sql`DROP TABLE topics`;
			yield* sql`DROP TABLE archive_thread`;
			yield* sql`DROP TABLE delivery_mark`;
			yield* sql`ALTER TABLE projects DROP COLUMN thread`;
			yield* sql`DELETE FROM requests WHERE json_extract(request, '$._tag') = 'phase'`;
			// Command replies and failures are posted on GitHub, so their notices left in the outbox are dropped.
			yield* sql`UPDATE notices SET sent_at = created_at WHERE sent_at IS NULL AND identifier LIKE 'CMD-%'`;
		}),
		'0014_create_t3_projects': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`
				CREATE TABLE t3_projects (
					repo TEXT PRIMARY KEY,
					project_id TEXT NOT NULL
				)
			`;
		}),
		'0015_add_threads': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs ADD COLUMN thread_id TEXT`;
			yield* sql`ALTER TABLE runs ADD COLUMN thread_run_id TEXT`;
		}),
		'0016_add_thread_settling_and_command_threads': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs ADD COLUMN thread_settled_at INTEGER`;
			yield* sql`ALTER TABLE commands ADD COLUMN thread_id TEXT`;
		}),
		'0017_drop_tabs': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`ALTER TABLE runs DROP COLUMN tab_id`;
			yield* sql`ALTER TABLE runs DROP COLUMN pane_id`;
			yield* sql`ALTER TABLE runs DROP COLUMN tail_hash`;
			yield* sql`UPDATE runs SET status = 'running' WHERE status = 'awaitingInput'`;
			yield* sql`UPDATE runs SET agent_status = NULL WHERE agent_status NOT IN ('working', 'idle', 'blocked')`;
			yield* sql`UPDATE runs SET handoff = NULL WHERE json_extract(handoff, '$.step') = 'cleared'`;
			yield* sql`ALTER TABLE commands DROP COLUMN tab_id`;
			yield* sql`ALTER TABLE commands DROP COLUMN pane_id`;
			yield* sql`ALTER TABLE commands DROP COLUMN session`;
			yield* sql`ALTER TABLE commands DROP COLUMN agent_status`;
			yield* sql`ALTER TABLE commands DROP COLUMN agent_status_since`;
			yield* sql`ALTER TABLE commands DROP COLUMN nudged_at`;
			yield* sql`ALTER TABLE commands DROP COLUMN tail_hash`;
			// Notices no rule writes any more are not posted.
			yield* sql`UPDATE notices SET sent_at = created_at WHERE sent_at IS NULL AND purpose IN ('awaitingInput', 'error', 'workingOrphan')`;
		}),
		'0018_create_epic_snapshots': Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			yield* sql`
				CREATE TABLE epic_snapshots (
					epic_id TEXT PRIMARY KEY,
					claimed_at INTEGER NOT NULL,
					taken_at INTEGER NOT NULL,
					issues TEXT NOT NULL,
					edits TEXT,
					edited_at INTEGER
				)
			`;
		}),
	}),
});

const EpicId = Schema.String;

export class Journal extends Context.Service<
	Journal,
	{
		readonly getRun: (epicId: string) => Effect.Effect<Option.Option<Run>, JournalError>;
		readonly listRuns: Effect.Effect<ReadonlyArray<Run>, JournalError>;
		// Inserts the run or replaces the one with the same epicId.
		readonly putRun: (run: Run) => Effect.Effect<void, JournalError>;
		readonly deleteRun: (epicId: string) => Effect.Effect<void, JournalError>;
		// Notes that the epic hit a Transient failure and returns when its current streak started.
		readonly recordTransient: (epicId: string) => Effect.Effect<number, JournalError>;
		// Ends the epic's Transient streak.
		readonly clearTransient: (epicId: string) => Effect.Effect<void, JournalError>;
		// Ordered by id.
		readonly listCommands: Effect.Effect<ReadonlyArray<Command>, JournalError>;
		// Does nothing when a command for the same comment exists.
		readonly addCommand: (command: NewCommand) => Effect.Effect<void, JournalError>;
		readonly putCommand: (command: Command) => Effect.Effect<void, JournalError>;
		// Returns the request's id.
		readonly addRequest: (request: Request) => Effect.Effect<number, JournalError>;
		// Oldest first.
		readonly listRequests: Effect.Effect<ReadonlyArray<RequestRow>, JournalError>;
		readonly deleteRequest: (id: number) => Effect.Effect<void, JournalError>;
		// Records the claim and drops the requests that asked for it in one transaction, so a crash never claims one twice
		// or loses it.
		readonly claimRun: (run: Run, requestIds: ReadonlyArray<number>) => Effect.Effect<void, JournalError>;
		// By team name.
		readonly listProjects: Effect.Effect<ReadonlyArray<Project>, JournalError>;
		// Inserts each project or replaces the one of the same team, all in one transaction.
		readonly putProjects: (projects: ReadonlyArray<Project>) => Effect.Effect<void, JournalError>;
		readonly deleteProject: (team: string) => Effect.Effect<void, JournalError>;
		// Puts the notice in the outbox; false when one with the same marker was put there already.
		readonly addNotice: (notice: Notice) => Effect.Effect<boolean, JournalError>;
		readonly hasNotice: (marker: Marker) => Effect.Effect<boolean, JournalError>;
		// Oldest first.
		readonly unsentNotices: Effect.Effect<ReadonlyArray<UnsentNotice>, JournalError>;
		readonly markNoticeSent: (id: number) => Effect.Effect<void, JournalError>;
		// Records that the run's subagent was told to hand off; false when it was already.
		readonly addSubagentHandoff: (handoff: SubagentHandoff) => Effect.Effect<boolean, JournalError>;
		readonly getT3Project: (repo: string) => Effect.Effect<Option.Option<string>, JournalError>;
		readonly listT3Projects: Effect.Effect<ReadonlyArray<T3ProjectRow>, JournalError>;
		// Inserts the row or replaces the one of the same repo.
		readonly putT3Project: (row: T3ProjectRow) => Effect.Effect<void, JournalError>;
		readonly listEpicSnapshots: Effect.Effect<ReadonlyArray<EpicSnapshot>, JournalError>;
		// Inserts the snapshot or replaces the one of the same epic.
		readonly putEpicSnapshot: (snapshot: EpicSnapshot) => Effect.Effect<void, JournalError>;
		readonly deleteEpicSnapshot: (epicId: string) => Effect.Effect<void, JournalError>;
	}
>()('sapphire-agent/Journal') {
	static readonly layer = (filename: string) =>
		Layer.effect(
			Journal,
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				const getRun = SqlSchema.findOneOption({
					Request: EpicId,
					Result: Run,
					execute: (epicId) => sql`SELECT * FROM runs WHERE epic_id = ${epicId}`,
				});

				const listRuns = SqlSchema.findAll({
					Request: Schema.Void,
					Result: Run,
					execute: () => sql`SELECT * FROM runs ORDER BY claimed_at`,
				})(undefined);

				const putRun = SqlSchema.void({
					Request: Run,
					execute: (row) => sql`INSERT OR REPLACE INTO runs ${sql.insert(row)}`,
				});

				const deleteRun = SqlSchema.void({
					Request: EpicId,
					execute: (epicId) => sql`DELETE FROM runs WHERE epic_id = ${epicId}`,
				});

				const upsertTransient = SqlSchema.findOne({
					Request: Schema.Struct({ epicId: EpicId, now: Millis }),
					Result: Schema.Struct({ firstSeenAt: Millis }),
					execute: ({ epicId, now }) => sql`
						INSERT INTO transient_failures (epic_id, first_seen_at) VALUES (${epicId}, ${now})
						ON CONFLICT (epic_id) DO UPDATE SET first_seen_at = first_seen_at
						RETURNING first_seen_at
					`,
				});

				const recordTransient = (epicId: string) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((now) => upsertTransient({ epicId, now })),
						Effect.map(({ firstSeenAt }) => firstSeenAt),
						// RETURNING yields the row on insert and on conflict alike.
						Effect.catchTag('NoSuchElementError', Effect.die),
					);

				const clearTransient = SqlSchema.void({
					Request: EpicId,
					execute: (epicId) => sql`DELETE FROM transient_failures WHERE epic_id = ${epicId}`,
				});

				const listCommands = SqlSchema.findAll({
					Request: Schema.Void,
					Result: Command,
					execute: () => sql`SELECT * FROM commands ORDER BY id`,
				})(undefined);

				const addCommand = SqlSchema.void({
					Request: NewCommand,
					execute: (row) => sql`INSERT INTO commands ${sql.insert(row)} ON CONFLICT (comment_id) DO NOTHING`,
				});

				const putCommand = SqlSchema.void({
					Request: Command,
					execute: (row) => sql`INSERT OR REPLACE INTO commands ${sql.insert(row)}`,
				});

				const insertRequest = SqlSchema.findOne({
					Request: RequestRow.mapFields(({ request, createdAt }) => ({ request, createdAt })),
					Result: Schema.Struct({ id: Schema.Int }),
					execute: (row) => sql`INSERT INTO requests ${sql.insert(row)} RETURNING id`,
				});

				const addRequest = (request: Request) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((createdAt) => insertRequest({ request, createdAt })),
						Effect.map(({ id }) => id),
						Effect.catchTag('NoSuchElementError', Effect.die),
					);

				const listRequests = SqlSchema.findAll({
					Request: Schema.Void,
					Result: RequestRow,
					execute: () => sql`SELECT * FROM requests ORDER BY id`,
				})(undefined);

				const deleteRequest = SqlSchema.void({
					Request: Schema.Int,
					execute: (id) => sql`DELETE FROM requests WHERE id = ${id}`,
				});

				const claimRun = (run: Run, requestIds: ReadonlyArray<number>) =>
					sql.withTransaction(putRun(run).pipe(Effect.andThen(Effect.forEach(requestIds, deleteRequest, { discard: true }))));

				const listProjects = selectProjects(sql);

				const putProject = SqlSchema.void({
					Request: Project,
					execute: (row) => sql`INSERT OR REPLACE INTO projects ${sql.insert(row)}`,
				});

				const putProjects = (projects: ReadonlyArray<Project>) => sql.withTransaction(Effect.forEach(projects, putProject, { discard: true }));

				const deleteProject = SqlSchema.void({
					Request: Schema.String,
					execute: (team) => sql`DELETE FROM projects WHERE team = ${team}`,
				});

				const insertNotice = SqlSchema.findOneOption({
					Request: Schema.Struct({ ...Marker.fields, text: Schema.String, createdAt: Millis }),
					Result: Schema.Struct({ id: Schema.Int }),
					execute: (row) => sql`INSERT INTO notices ${sql.insert(row)} ON CONFLICT (identifier, purpose, key) DO NOTHING RETURNING id`,
				});

				const addNotice = ({ marker, text }: Notice) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((createdAt) => insertNotice({ ...marker, text, createdAt })),
						Effect.map(Option.isSome),
					);

				const findNotice = SqlSchema.findOneOption({
					Request: Marker,
					Result: Schema.Struct({ id: Schema.Int }),
					execute: ({ identifier, purpose, key }) => sql`SELECT id FROM notices WHERE identifier = ${identifier} AND purpose = ${purpose} AND key = ${key}`,
				});

				const hasNotice = (marker: Marker) => findNotice(marker).pipe(Effect.map(Option.isSome));

				const unsentNotices = SqlSchema.findAll({
					Request: Schema.Void,
					Result: UnsentNotice,
					execute: () => sql`SELECT id, identifier, purpose, key, text FROM notices WHERE sent_at IS NULL ORDER BY id`,
				})(undefined);

				const markSent = SqlSchema.void({
					Request: Schema.Struct({ id: Schema.Int, sentAt: Millis }),
					execute: ({ id, sentAt }) => sql`UPDATE notices SET sent_at = ${sentAt} WHERE id = ${id}`,
				});

				const markNoticeSent = (id: number) => Clock.currentTimeMillis.pipe(Effect.flatMap((sentAt) => markSent({ id, sentAt })));

				const insertSubagentHandoff = SqlSchema.findOneOption({
					Request: Schema.Struct({ ...SubagentHandoff.fields, requestedAt: Millis }),
					Result: Schema.Struct({ agentId: Schema.String }),
					execute: (row) => sql`INSERT INTO subagent_handoffs ${sql.insert(row)} ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id`,
				});

				const addSubagentHandoff = (handoff: SubagentHandoff) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((requestedAt) => insertSubagentHandoff({ ...handoff, requestedAt })),
						Effect.map(Option.isSome),
					);

				const findT3Project = SqlSchema.findOneOption({
					Request: Schema.String,
					Result: T3ProjectRow,
					execute: (repo) => sql`SELECT * FROM t3_projects WHERE repo = ${repo}`,
				});

				const getT3Project = (repo: string) => findT3Project(repo).pipe(Effect.map(Option.map(({ projectId }) => projectId)));

				const listT3Projects = SqlSchema.findAll({
					Request: Schema.Void,
					Result: T3ProjectRow,
					execute: () => sql`SELECT * FROM t3_projects ORDER BY repo`,
				})(undefined);

				const putT3Project = SqlSchema.void({
					Request: T3ProjectRow,
					execute: (row) => sql`INSERT OR REPLACE INTO t3_projects ${sql.insert(row)}`,
				});

				const listEpicSnapshots = SqlSchema.findAll({
					Request: Schema.Void,
					Result: EpicSnapshot,
					execute: () => sql`SELECT * FROM epic_snapshots ORDER BY epic_id`,
				})(undefined);

				const putEpicSnapshot = SqlSchema.void({
					Request: EpicSnapshot,
					execute: (row) => sql`INSERT OR REPLACE INTO epic_snapshots ${sql.insert(row)}`,
				});

				const deleteEpicSnapshot = SqlSchema.void({
					Request: EpicId,
					execute: (epicId) => sql`DELETE FROM epic_snapshots WHERE epic_id = ${epicId}`,
				});

				return Journal.of({
					getRun,
					listRuns,
					putRun,
					deleteRun,
					recordTransient,
					clearTransient,
					listCommands,
					addCommand,
					putCommand,
					addRequest,
					listRequests,
					deleteRequest,
					claimRun,
					listProjects,
					putProjects,
					deleteProject,
					addNotice,
					hasNotice,
					unsentNotices,
					markNoticeSent,
					addSubagentHandoff,
					getT3Project,
					listT3Projects,
					putT3Project,
					listEpicSnapshots,
					putEpicSnapshot,
					deleteEpicSnapshot,
				});
			}),
		).pipe(
			Layer.provide(migrations),
			Layer.provide(clientLayer(filename)),
		);
}
