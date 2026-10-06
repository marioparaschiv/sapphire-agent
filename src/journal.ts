import { randomUUID } from 'node:crypto';
import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Clock, Context, Effect, Layer, Option, Schema, String } from 'effect';
import { SqlClient, type SqlError, SqlSchema } from 'effect/sql';
import { EpicState, MessageRef, Phase, ThreadRef } from './chat.ts';
import { ResultFile } from './result-file.ts';

// claimed: recorded before the run is started. running: Claude is confirmed started. awaitingInput: the agent sat
// idle or blocked without a PR. stale: herdr says working but the pane stopped changing. error: the agent exited or
// vanished, or the run never started. ended: the run is over and its tab closed; the worktree stays until the epic
// ships or its PR is merged or closed. kept: cleanup found work that is not on origin, so the worktree stays.
export const RunStatus = Schema.Literals(['claimed', 'running', 'awaitingInput', 'stale', 'error', 'ended', 'kept']);

export type RunStatus = typeof RunStatus.Type;

export const AgentStatus = Schema.Literals(['working', 'idle', 'done', 'blocked', 'unknown', 'exited', 'vanished']);

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

// Made when a run or command is claimed and kept from then on, so a start after a crash resumes into the same session.
export const newSession = (identifier: string) => Effect.sync((): Session => ({ id: randomUUID(), name: sessionName(identifier) }));

// Only what cannot be observed from Linear, herdr, git or GitHub. Times are epoch milliseconds.
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
	tabId: Schema.NullOr(Schema.String),
	paneId: Schema.NullOr(Schema.String),
	// None for a run claimed before sessions were recorded, or adopted from a tab Claude already ran in.
	session: Schema.NullOr(Schema.fromJsonString(Session)),
	// The Claude session that asked for the run (`ctl.sh start --reply-to`), which its agent asks its questions. None asks on Linear.
	replyTo: Schema.NullOr(Schema.String),
	claimedAt: Millis,
	// When Claude was confirmed started in the pane.
	startedAt: Schema.NullOr(Millis),
	agentStatus: Schema.NullOr(AgentStatus),
	// When the agent status or, while working, the pane tail last changed.
	agentStatusSince: Schema.NullOr(Millis),
	// When the current stale episode's nudge was sent; cleared once the pane changes.
	nudgedAt: Schema.NullOr(Millis),
	tailHash: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Schema.fromJsonString(ResultFile)),
	// The awaitingInput comment whose replies are typed into the pane; cleared when the episode ends.
	questionCommentId: Schema.NullOr(Schema.String),
	// Replies already typed into the pane, so a crash before the delivery emoji is added never types one twice.
	deliveredReplyIds: Schema.fromJsonString(Schema.Array(Schema.String)),
});

export type Run = typeof Run.Type;

// ignored: the comment's author is not in bot.allowedUsers, so nothing runs. queued: waiting for its turn, as commands
// run one at a time. claimed: its turn came and it is being started. running: Claude is confirmed started. ended: the agent said it was done and its tab is closed.
// error: it failed to start, exited, went quiet or stale without saying it was done, or ran over the cap; the comment
// it answers got a reply saying so and its tab is closed.
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
	// The local clone the agent runs in, once found.
	cwd: Schema.NullOr(Schema.String),
	tabId: Schema.NullOr(Schema.String),
	paneId: Schema.NullOr(Schema.String),
	// Made when it is claimed.
	session: Schema.NullOr(Schema.fromJsonString(Session)),
	recordedAt: Millis,
	// When its turn came. Keys its markers, starts its start timeout and its wall-clock cap.
	claimedAt: Schema.NullOr(Millis),
	startedAt: Schema.NullOr(Millis),
	agentStatus: Schema.NullOr(AgentStatus),
	agentStatusSince: Schema.NullOr(Millis),
	nudgedAt: Schema.NullOr(Millis),
	tailHash: Schema.NullOr(Schema.String),
	// When the comment got the App's thumbs-up, which tells its author the bot has it before any reply.
	acknowledgedAt: Schema.NullOr(Millis),
});

export type NewCommand = typeof NewCommand.Type;

// `id` numbers commands in the order their comments were seen; `CMD-<id>` names one in logs, markers and the CLI.
export const Command = Schema.Struct({ id: Schema.Int, ...NewCommand.fields });

export type Command = typeof Command.Type;

export const commandIdentifier = (command: Pick<Command, 'id'>) => `CMD-${command.id}`;

// What `scripts/ctl.sh` and the agent event server ask the reconciler to do on its next tick. Both only append these,
// so they never race a rule over a row; the rule that acts on one deletes it.
export const Request = Schema.Union([
	Schema.TaggedStruct('start', { identifier: Schema.String, replyTo: Schema.NullOr(Schema.String) }),
	Schema.TaggedStruct('stop', { identifier: Schema.String }),
	Schema.TaggedStruct('send', { identifier: Schema.String, text: Schema.String }),
	Schema.TaggedStruct('follow-up', { identifier: Schema.String, instruction: Schema.NullOr(Schema.String), threadIds: Schema.Array(Schema.String) }),
	Schema.TaggedStruct('reply', { commandId: Schema.Int, body: Schema.String }),
	Schema.TaggedStruct('done', { commandId: Schema.Int }),
	// Recorded by the agent event server when a run's agent starts another session in its pane.
	Schema.TaggedStruct('session', { identifier: Schema.String, sessionId: Schema.String }),
	// Recorded by the agent event server when a run's agent starts a phase.
	Schema.TaggedStruct('phase', { identifier: Schema.String, phase: Phase }),
]);

export type Request = typeof Request.Type;

export const RequestRow = Schema.Struct({ id: Schema.Int, request: Schema.fromJsonString(Request), createdAt: Millis });

export type RequestRow = typeof RequestRow.Type;

// An epic's thread in the chat: made when its run is dispatched, gone once the epic ships or its run stops.
export const Topic = Schema.Struct({
	epicId: Schema.String,
	identifier: Schema.String,
	thread: ThreadRef,
	// What the thread shows now.
	state: EpicState,
	// The PR whose link was posted, so it is posted once.
	pullRequestUrl: Schema.NullOr(Schema.String),
	// The slice milestones posted, `<sub-issue id>:<progress>`, so each is posted once.
	milestones: Schema.fromJsonString(Schema.Array(Schema.String)),
});

export type Topic = typeof Topic.Type;

export type JournalError = SqlError.SqlError | Schema.SchemaError;

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
		// When the newest webhook delivery the last complete scan saw was delivered, in ms; none before the first scan.
		readonly deliveryMark: Effect.Effect<Option.Option<number>, JournalError>;
		readonly setDeliveryMark: (deliveredAt: number) => Effect.Effect<void, JournalError>;
		// Records that the main chat's bot messages were written in the Claude session.
		readonly addChatSession: (messageRefs: ReadonlyArray<MessageRef>, sessionId: string) => Effect.Effect<void, JournalError>;
		readonly chatSession: (messageRef: MessageRef) => Effect.Effect<Option.Option<string>, JournalError>;
		// The session of the newest bot message.
		readonly latestChatSession: Effect.Effect<Option.Option<string>, JournalError>;
		readonly listTopics: Effect.Effect<ReadonlyArray<Topic>, JournalError>;
		// Inserts the topic or replaces the one of the same epic.
		readonly putTopic: (topic: Topic) => Effect.Effect<void, JournalError>;
		readonly deleteTopic: (epicId: string) => Effect.Effect<void, JournalError>;
		readonly archiveThread: Effect.Effect<Option.Option<ThreadRef>, JournalError>;
		readonly setArchiveThread: (thread: ThreadRef) => Effect.Effect<void, JournalError>;
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

				const deliveryMark = SqlSchema.findOneOption({
					Request: Schema.Void,
					Result: Schema.Struct({ deliveredAt: Millis }),
					execute: () => sql`SELECT delivered_at FROM delivery_mark`,
				})(undefined).pipe(Effect.map(Option.map(({ deliveredAt }) => deliveredAt)));

				const setDeliveryMark = SqlSchema.void({
					Request: Millis,
					execute: (deliveredAt) => sql`INSERT OR REPLACE INTO delivery_mark (id, delivered_at) VALUES (1, ${deliveredAt})`,
				});

				const insertChatSession = SqlSchema.void({
					Request: Schema.Struct({ messageRef: MessageRef, sessionId: Schema.String, createdAt: Millis }),
					execute: (row) => sql`INSERT OR REPLACE INTO chat_sessions ${sql.insert(row)}`,
				});

				const addChatSession = (messageRefs: ReadonlyArray<MessageRef>, sessionId: string) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((createdAt) =>
							sql.withTransaction(Effect.forEach(messageRefs, (messageRef) => insertChatSession({ messageRef, sessionId, createdAt }), { discard: true })),
						),
					);

				const chatSession = (messageRef: MessageRef) =>
					SqlSchema.findOneOption({
						Request: MessageRef,
						Result: Schema.Struct({ sessionId: Schema.String }),
						execute: (ref) => sql`SELECT session_id FROM chat_sessions WHERE message_ref = ${ref}`,
					})(messageRef).pipe(Effect.map(Option.map(({ sessionId }) => sessionId)));

				const latestChatSession = SqlSchema.findOneOption({
					Request: Schema.Void,
					Result: Schema.Struct({ sessionId: Schema.String }),
					execute: () => sql`SELECT session_id FROM chat_sessions ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				})(undefined).pipe(Effect.map(Option.map(({ sessionId }) => sessionId)));

				const listTopics = SqlSchema.findAll({
					Request: Schema.Void,
					Result: Topic,
					execute: () => sql`SELECT * FROM topics ORDER BY rowid`,
				})(undefined);

				const putTopic = SqlSchema.void({
					Request: Topic,
					execute: (row) => sql`INSERT OR REPLACE INTO topics ${sql.insert(row)}`,
				});

				const deleteTopic = SqlSchema.void({
					Request: EpicId,
					execute: (epicId) => sql`DELETE FROM topics WHERE epic_id = ${epicId}`,
				});

				const archiveThread = SqlSchema.findOneOption({
					Request: Schema.Void,
					Result: Schema.Struct({ thread: ThreadRef }),
					execute: () => sql`SELECT thread FROM archive_thread`,
				})(undefined).pipe(Effect.map(Option.map(({ thread }) => thread)));

				const setArchiveThread = SqlSchema.void({
					Request: ThreadRef,
					execute: (thread) => sql`INSERT OR REPLACE INTO archive_thread (id, thread) VALUES (1, ${thread})`,
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
					deliveryMark,
					setDeliveryMark,
					addChatSession,
					chatSession,
					latestChatSession,
					listTopics,
					putTopic,
					deleteTopic,
					archiveThread,
					setArchiveThread,
				});
			}),
		).pipe(
			Layer.provide(migrations),
			Layer.provide(
				SqliteClient.layer({ filename, transformQueryNames: String.camelToSnake, transformResultNames: String.snakeToCamel }),
			),
		);
}
