import { Context, Duration, Effect, Layer, Option, Redacted, Schema, SynchronizedRef } from 'effect';
import { Headers, HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http';
import { type CallError, callTimeouts, Permanent, Transient, timeoutAsTransient, transportFailure, withCallPolicy } from './call-policy.ts';
import { T3Config } from './config.ts';

const mcpProtocolVersion = '2025-06-18';

// T3 refused the token: it was revoked, it expired, or T3 changed its token format.
export class T3Unauthorized extends Schema.TaggedError<T3Unauthorized>()('T3Unauthorized', { message: Schema.String }) {}

const T3FailureCode = Schema.Literals([
	'capability_denied',
	'parent_not_active',
	'provider_unavailable',
	'model_unavailable',
	'runtime_mode_escalation_denied',
	'interaction_mode_escalation_denied',
	'task_not_found',
	'task_not_cancellable',
	'thread_not_found',
	'run_not_found',
	'thread_not_sendable',
	'thread_not_interruptible',
	'invalid_request',
	'orchestration_error',
	'thread_credential_required',
	'target_required',
]);

// A tool call T3 refused, e.g. reading a thread that is gone.
export class T3ToolFailure extends Schema.TaggedError<T3ToolFailure>()('T3ToolFailure', {
	tool: Schema.String,
	code: T3FailureCode,
	message: Schema.String,
}) {}

export type T3Error = CallError | T3Unauthorized | T3ToolFailure;

export const RunStatus = Schema.Literals(['preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

export type RunStatus = typeof RunStatus.Type;

// idle: the thread has had no run yet.
export const ThreadStatus = Schema.Union([Schema.Literal('idle'), RunStatus]);

export type ThreadStatus = typeof ThreadStatus.Type;

const TerminalRunStatus = Schema.Literals(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

export const isTerminalRunStatus = Schema.is(TerminalRunStatus);

// The thread's newest run has not ended, waiting on the user included.
export const hasActiveRun = (status: ThreadStatus) => status !== 'idle' && !isTerminalRunStatus(status);

// The thread's newest run ended without completing, e.g. failed or interrupted.
export const hasFailedRun = (status: ThreadStatus | null) => status !== null && status !== 'completed' && isTerminalRunStatus(status);

export const T3Project = Schema.Struct({ id: Schema.String, title: Schema.String, workspaceRoot: Schema.String });

export type T3Project = typeof T3Project.Type;

const threadFields = {
	threadId: Schema.String,
	title: Schema.String,
	status: ThreadStatus,
	latestRunId: Schema.NullOr(Schema.String),
	settled: Schema.Boolean,
	// Set for a subagent of the run's agent, or a fork.
	parentThreadId: Schema.NullOr(Schema.String),
	relationshipToParent: Schema.NullOr(Schema.Literals(['fork', 'subagent'])),
	createdAt: Schema.String,
	updatedAt: Schema.String,
};

export const ThreadSummary = Schema.Struct(threadFields);

export type ThreadSummary = typeof ThreadSummary.Type;

const TimelineItem = Schema.Struct({ type: Schema.String, updatedAt: Schema.String });

export const ThreadRead = Schema.Struct({
	thread: Schema.Struct({
		...threadFields,
		projectId: Schema.String,
		worktreePath: Schema.NullOr(Schema.String),
		// Every timeline item; positions run from 0 to itemCount - 1.
		itemCount: Schema.Int,
		// Questions and approvals waiting for the user.
		pendingRequestCount: Schema.Int,
	}),
	items: Schema.Array(TimelineItem),
});

export type ThreadRead = typeof ThreadRead.Type;

const Launched = Schema.Struct({
	threadId: Schema.String,
	projectId: Schema.String,
	// Null for a thread launched without a message.
	runId: Schema.NullOr(Schema.String),
	status: Schema.NullOr(RunStatus),
});

type Launched = typeof Launched.Type;

const Waited = Schema.Struct({ threadId: Schema.String, runId: Schema.NullOr(Schema.String), status: ThreadStatus, timedOut: Schema.Boolean });

type Waited = typeof Waited.Type;

export const Sent = Schema.Struct({
	threadId: Schema.String,
	runId: Schema.String,
	status: RunStatus,
	delivery: Schema.Literals(['started', 'queued', 'steered', 'restarted']),
});

export type Sent = typeof Sent.Type;

export const Interrupted = Schema.Struct({
	threadId: Schema.String,
	runId: Schema.NullOr(Schema.String),
	status: Schema.Union([Schema.Literals(['interrupt_requested', 'no_active_run']), TerminalRunStatus]),
});

export type Interrupted = typeof Interrupted.Type;

const ProjectPage = Schema.Struct({ projects: Schema.Array(T3Project), nextCursor: Schema.NullOr(Schema.Int) });

const ThreadPage = Schema.Struct({ threads: Schema.Array(ThreadSummary), nextCursor: Schema.NullOr(Schema.Int) });

const Organized = Schema.Struct({ sequence: Schema.Int });

// worktree: a new checkout from baseRef. existing_worktree: one of the project's git worktrees. root: the project checkout.
export type WorkspaceStrategy =
	| { readonly type: 'root'; readonly branch?: string }
	| { readonly type: 'existing_worktree'; readonly worktreePath: string; readonly branch?: string }
	| { readonly type: 'worktree'; readonly baseRef: string; readonly branch?: string; readonly startFromOrigin?: boolean };

export type LaunchInput = {
	readonly projectId: string;
	readonly title: string;
	// The first prompt; none launches an idle thread.
	readonly message?: string;
	readonly workspaceStrategy?: WorkspaceStrategy;
	readonly runtimeMode?: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
};

export type ThreadFilter = {
	readonly projectId: string;
	readonly statuses?: ReadonlyArray<ThreadStatus>;
	readonly titleContains?: string;
	// Omitted lists settled and unsettled threads alike.
	readonly settled?: boolean;
	// T3 lists subagents unless this is false.
	readonly includeSubagents?: boolean;
};

type ReadInput = {
	readonly threadId: string;
	// messages (the default): user and assistant messages and plans. activity: every timeline item.
	readonly view?: 'messages' | 'activity';
	readonly afterPosition?: number;
	readonly limit?: number;
	readonly maxCharsPerItem?: number;
};

// clientRequestId makes a retry of the same message or interrupt land once.
export type SendInput = {
	readonly threadId: string;
	readonly message: string;
	// auto: starts an idle thread, steers an active turn, or queues behind a turn not yet steerable.
	readonly mode?: 'auto' | 'queue' | 'steer' | 'restart';
	readonly clientRequestId: string;
};

type InterruptInput = { readonly threadId: string; readonly runId?: string; readonly reason?: string; readonly clientRequestId: string };

type T3Shape = {
	// Fails T3Unauthorized when T3 refuses the token.
	readonly ping: Effect.Effect<void, T3Error>;
	readonly listProjects: Effect.Effect<ReadonlyArray<T3Project>, T3Error>;
	// T3 refuses a workspace root that belongs to a project already.
	readonly createProject: (input: { readonly title: string; readonly workspaceRoot: string }) => Effect.Effect<T3Project, T3Error>;
	// Has no retry key: after a failure, list the project's threads before launching again.
	readonly launchThread: (input: LaunchInput) => Effect.Effect<Launched, T3Error>;
	// Newest first, every page.
	readonly listThreads: (filter: ThreadFilter) => Effect.Effect<ReadonlyArray<ThreadSummary>, T3Error>;
	readonly readThread: (input: ReadInput) => Effect.Effect<ThreadRead, T3Error>;
	// Returns once the run (by default the latest) is terminal or the thread idle, or after timeoutMs with timedOut set.
	// Waiting never interrupts the run.
	readonly waitThread: (input: { readonly threadId: string; readonly runId?: string; readonly timeoutMs: number }) => Effect.Effect<Waited, T3Error>;
	readonly sendThread: (input: SendInput) => Effect.Effect<Sent, T3Error>;
	// Without runId, the newest interruptible run.
	readonly interruptThread: (input: InterruptInput) => Effect.Effect<Interrupted, T3Error>;
	readonly organizeThread: (input: { readonly threadId: string; readonly action: 'settle' }) => Effect.Effect<void, T3Error>;
};

// Reads and the writes T3 dedupes by clientRequestId are retried. A launch or project creation has no retry key, so an
// attempt that failed may still have landed and is not repeated: the next tick finds it. The ping every tick waits on
// is not repeated either, so a T3 that is down does not hold the tick up.
export const t3Policy = {
	call: withCallPolicy(callTimeouts.t3),
	once: timeoutAsTransient(callTimeouts.t3),
	// T3 holds a wait until the run ends or timeoutMs passes, so the timeout must outlast timeoutMs.
	wait: (timeoutMs: number) => withCallPolicy(Duration.sum(Duration.millis(timeoutMs), callTimeouts.t3)),
};

// T3 answers 404 to a session it no longer knows, e.g. after it restarted.
class SessionGone extends Schema.TaggedError<SessionGone>()('SessionGone', { sessionId: Schema.String }) {}

const JsonRpcReply = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
		result: Schema.optionalKey(Schema.Unknown),
		error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
	}),
);

const ToolResult = Schema.Struct({
	content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
	structuredContent: Schema.optionalKey(Schema.Unknown),
	isError: Schema.optionalKey(Schema.Boolean),
});

const ToolFailureText = Schema.fromJsonString(Schema.Struct({ _tag: Schema.Literal('OrchestratorMcpFailure'), code: T3FailureCode, message: Schema.String }));

const UnknownFromJson = Schema.fromJsonString(Schema.Unknown);

// The `data:` of each server-sent event. T3 streams its reply when notifications precede the result.
const eventData = (text: string) =>
	text
		.split(/\r?\n\r?\n/)
		.map((event) =>
			event
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice('data:'.length).trimStart())
				.join('\n'),
		)
		.filter((data) => data !== '');

const unreadable = (what: string) => (cause: Schema.SchemaError) => new Permanent({ message: `T3 answered ${what} with unexpected data: ${cause.message}`, cause });

const make = Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient;
	const { url, token } = yield* T3Config;
	const endpoint = `${url}/mcp`;
	const session = yield* SynchronizedRef.make(Option.none<string>());
	let lastRequestId = 0;

	const post = (body: unknown, sessionId: Option.Option<string>) =>
		HttpClientRequest.post(endpoint).pipe(
			HttpClientRequest.bearerToken(Redacted.value(token)),
			HttpClientRequest.setHeaders({
				accept: 'application/json, text/event-stream',
				...Option.match(sessionId, { onNone: () => ({}), onSome: (id) => ({ 'mcp-session-id': id, 'mcp-protocol-version': mcpProtocolVersion }) }),
			}),
			HttpClientRequest.bodyJsonUnsafe(body),
			client.execute,
			Effect.mapError(transportFailure('T3')),
		);

	const failOnStatus = (response: HttpClientResponse.HttpClientResponse) =>
		Effect.gen(function* () {
			const { status } = response;

			if (status >= 200 && status < 300) {
				return;
			}

			const text = yield* response.text.pipe(Effect.mapError(transportFailure('T3')));
			const said = `T3 answered HTTP ${status}${text.trim() === '' ? '' : `: ${text.trim()}`}`;

			if (status === 401) {
				return yield* new T3Unauthorized({ message: said });
			}

			return yield* status >= 500 ? new Transient({ message: said }) : new Permanent({ message: said });
		});

	// The result of the JSON-RPC request with the given id.
	const resultOf = (response: HttpClientResponse.HttpClientResponse, method: string, id: number) =>
		Effect.gen(function* () {
			const text = yield* response.text.pipe(Effect.mapError(transportFailure('T3')));
			const isStream = Headers.get(response.headers, 'content-type').pipe(Option.exists((type) => type.startsWith('text/event-stream')));
			const replies = yield* Effect.forEach(isStream ? eventData(text) : [text], (data) => Schema.decodeEffect(JsonRpcReply)(data)).pipe(Effect.mapError(unreadable(method)));
			const reply = replies.find((candidate) => candidate.id === id);

			if (reply === undefined) {
				return yield* new Permanent({ message: `T3 answered ${method} without a reply to request ${id}` });
			}

			if (reply.error !== undefined) {
				return yield* new Permanent({ message: `T3 refused ${method}: ${reply.error.message} (${reply.error.code})` });
			}

			return reply.result;
		});

	// Opens an MCP session: initialize, then notifications/initialized, both required before any other request.
	const initialize = Effect.gen(function* () {
		const id = ++lastRequestId;
		const response = yield* post(
			{ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: mcpProtocolVersion, capabilities: {}, clientInfo: { name: 'sapphire-agent', version: '0.1.0' } } },
			Option.none(),
		);

		yield* failOnStatus(response);

		const sessionId = Headers.get(response.headers, 'mcp-session-id');

		yield* resultOf(response, 'initialize', id);

		if (Option.isNone(sessionId)) {
			return yield* new Permanent({ message: 'T3 answered initialize without an mcp-session-id' });
		}

		yield* post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).pipe(Effect.flatMap(failOnStatus));

		return sessionId.value;
	});

	const currentSession = SynchronizedRef.modifyEffect(session, (current) =>
		Option.match(current, {
			onSome: (id) => Effect.succeed([id, current] as const),
			onNone: () => initialize.pipe(Effect.map((id) => [id, Option.some(id)] as const)),
		}),
	);

	const forget = (sessionId: string) => SynchronizedRef.update(session, (current) => (Option.contains(current, sessionId) ? Option.none() : current));

	const request = (method: string, params: unknown) => {
		const attempt = Effect.gen(function* () {
			const sessionId = yield* currentSession;
			const id = ++lastRequestId;
			const response = yield* post({ jsonrpc: '2.0', id, method, params }, Option.some(sessionId));

			if (response.status === 404) {
				return yield* new SessionGone({ sessionId });
			}

			yield* failOnStatus(response);

			return yield* resultOf(response, method, id);
		});

		return attempt.pipe(
			Effect.catchTag('SessionGone', ({ sessionId }) => forget(sessionId).pipe(Effect.andThen(attempt))),
			Effect.catchTag('SessionGone', () => Effect.fail(new Permanent({ message: `T3 forgot a new MCP session at once, answering ${method} with HTTP 404` }))),
		);
	};

	const textOf = (result: typeof ToolResult.Type) => result.content.flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : [])).join('');

	const callTool = <A>(tool: string, args: object, success: Schema.ConstraintDecoder<A>) =>
		Effect.gen(function* () {
			const result = yield* request('tools/call', { name: tool, arguments: args }).pipe(
				Effect.flatMap((value) => Schema.decodeUnknownEffect(ToolResult)(value).pipe(Effect.mapError(unreadable(tool)))),
			);

			if (result.isError) {
				const text = textOf(result);
				const failure = yield* Schema.decodeEffect(ToolFailureText)(text).pipe(Effect.mapError(() => new Permanent({ message: `T3 failed ${tool}: ${text}` })));

				return yield* new T3ToolFailure({ tool, code: failure.code, message: failure.message });
			}

			const value = result.structuredContent ?? (yield* Schema.decodeEffect(UnknownFromJson)(textOf(result)).pipe(Effect.mapError(unreadable(tool))));

			return yield* Schema.decodeUnknownEffect(success)(value).pipe(Effect.mapError(unreadable(tool)));
		});

	const allPages = <A>(next: (cursor: number) => Effect.Effect<{ readonly items: ReadonlyArray<A>; readonly nextCursor: number | null }, T3Error>) =>
		Effect.gen(function* () {
			const items: Array<A> = [];
			let cursor: number | null = 0;

			while (cursor !== null) {
				const page: { readonly items: ReadonlyArray<A>; readonly nextCursor: number | null } = yield* next(cursor);

				items.push(...page.items);
				cursor = page.nextCursor;
			}

			return items;
		});

	return T3.of({
		ping: request('ping', {}).pipe(Effect.asVoid, t3Policy.once),

		listProjects: allPages((cursor) =>
			callTool('t3_project_list', { cursor, limit: 100 }, ProjectPage).pipe(
				Effect.map(({ projects, nextCursor }) => ({ items: projects, nextCursor })),
				t3Policy.call,
			),
		),

		createProject: ({ title, workspaceRoot }) => callTool('t3_project_create', { title, workspaceRoot }, T3Project).pipe(t3Policy.once),

		launchThread: (input) => callTool('t3_thread_launch', input, Launched).pipe(t3Policy.once),

		listThreads: (filter) =>
			allPages((cursor) =>
				callTool('t3_thread_list', { ...filter, cursor, limit: 100 }, ThreadPage).pipe(
					Effect.map(({ threads, nextCursor }) => ({ items: threads, nextCursor })),
					t3Policy.call,
				),
			),

		readThread: (input) => callTool('t3_thread_read', input, ThreadRead).pipe(t3Policy.call),

		waitThread: (input) => callTool('t3_thread_wait', input, Waited).pipe(t3Policy.wait(input.timeoutMs)),

		sendThread: (input) => callTool('t3_thread_send', input, Sent).pipe(t3Policy.call),

		interruptThread: (input) => callTool('t3_thread_interrupt', input, Interrupted).pipe(t3Policy.call),

		organizeThread: (input) => callTool('t3_thread_organize', input, Organized).pipe(Effect.asVoid, t3Policy.call),
	});
});

// The T3 Code server's MCP endpoint, as a client outside any T3 thread with the full-access token.
export class T3 extends Context.Service<T3, T3Shape>()('sapphire-agent/T3') {
	static readonly layer = Layer.effect(T3, make);
}
