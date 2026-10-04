import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Clock, Context, Effect, Layer, type Option, Schema, String } from 'effect';
import { SqlClient, type SqlError, SqlSchema } from 'effect/sql';
import { ResultFile } from './result-file.ts';

// claimed: recorded before the run is started. running: Claude is confirmed started. awaitingInput: the agent sat
// idle or blocked without a PR. stale: herdr says working but the pane stopped changing. error: the agent exited or
// vanished, or the run never started. ended: the run is over and its tab closed; the worktree stays until the epic
// ships or its PR is merged or closed. kept: cleanup found work that is not on origin, so the worktree stays.
export const RunStatus = Schema.Literals(['claimed', 'running', 'awaitingInput', 'stale', 'error', 'ended', 'kept']);

export type RunStatus = typeof RunStatus.Type;

export const AgentStatus = Schema.Literals(['working', 'idle', 'done', 'blocked', 'unknown', 'exited', 'vanished']);

export type AgentStatus = typeof AgentStatus.Type;

// A follow-up run answers the pending review threads it was dispatched for.
export const Job = Schema.Union([Schema.TaggedStruct('orchestrate', {}), Schema.TaggedStruct('follow-up', { threadIds: Schema.Array(Schema.String) })]);

export type Job = typeof Job.Type;

const Millis = Schema.Int;

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
	}
>()('herdr-linear/Journal') {
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

				return Journal.of({ getRun, listRuns, putRun, deleteRun, recordTransient, clearTransient });
			}),
		).pipe(
			Layer.provide(migrations),
			Layer.provide(
				SqliteClient.layer({ filename, transformQueryNames: String.camelToSnake, transformResultNames: String.snakeToCamel }),
			),
		);
}
