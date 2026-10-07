import { basename } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Stream, SubscriptionRef } from 'effect';
import { T3Config } from './config.ts';
import {
	type Interrupted,
	type LaunchInput,
	type RunStatus,
	type SendInput,
	type Sent,
	T3,
	type T3Error,
	type T3Project,
	t3Policy,
	T3ToolFailure,
	T3Unauthorized,
	isTerminalRunStatus,
	type ThreadFilter,
	type ThreadRead,
	type ThreadStatus,
	type ThreadSummary,
} from './t3.ts';
import { defaultModelSelection, type ModelSelection } from './t3-settings.ts';

type FakeRun = { readonly runId: string; readonly status: RunStatus; readonly message: string; readonly requestedAt: string };

// A timeline item: each message sent, and what the agent did.
type FakeItem = { readonly itemId: string; readonly runId: string | null; readonly type: string; readonly text: string | null; readonly updatedAt: string };

export type FakeThread = {
	readonly threadId: string;
	readonly projectId: string;
	readonly title: string;
	// Oldest first.
	readonly runs: ReadonlyArray<FakeRun>;
	// Oldest first; an item's position is its index.
	readonly items: ReadonlyArray<FakeItem>;
	readonly pendingRequestCount: number;
	readonly settled: boolean;
	readonly parentThreadId: string | null;
	readonly relationshipToParent: 'fork' | 'subagent' | null;
	readonly worktreePath: string | null;
	readonly branch: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
};

type LaunchOutcome = { readonly code: T3ToolFailure['code']; readonly message: string } | { readonly status: RunStatus };

// What a t3_thread_launch carried: the caller's input and the default model the port added.
type FakeLaunch = LaunchInput & { readonly modelSelection: ModelSelection };

type State = { readonly projects: ReadonlyArray<T3Project>; readonly threads: ReadonlyArray<FakeThread> };

export type FakeT3Controls = {
	// Titled after the directory unless given a title.
	readonly addProject: (workspaceRoot: string, title?: string) => Effect.Effect<T3Project>;
	readonly projects: Effect.Effect<ReadonlyArray<T3Project>>;
	readonly thread: (threadId: string) => Effect.Effect<Option.Option<FakeThread>>;
	// A subagent the thread's agent started, with one run in the given status.
	readonly addSubagent: (parentThreadId: string, title: string, status: RunStatus) => Effect.Effect<string>;
	// Moves the thread's latest run on, e.g. to completed, as its agent does.
	readonly setRunStatus: (threadId: string, status: RunStatus) => Effect.Effect<void>;
	// A thread launched on a new worktree has none until T3 made it, after the launch answered.
	readonly setWorktreePath: (threadId: string, path: string) => Effect.Effect<void>;
	// The thread's agent did something: a new timeline item, and the thread's updatedAt, at the current time.
	readonly addActivity: (threadId: string) => Effect.Effect<void>;
	// The newest timeline item changed, e.g. a command streaming its output, while the thread's updatedAt stayed.
	readonly updateLastItem: (threadId: string) => Effect.Effect<void>;
	// Questions or approvals waiting for the user.
	readonly setPendingRequests: (threadId: string, count: number) => Effect.Effect<void>;
	// As the user, or T3's auto-settle, does in the app.
	readonly setSettled: (threadId: string, settled: boolean) => Effect.Effect<void>;
	// From now on, launches are refused this way, or their first run starts in this status; null as T3 does.
	readonly setLaunchOutcome: (outcome: LaunchOutcome | null) => Effect.Effect<void>;
	// What each t3_thread_launch asked for, oldest first.
	readonly launches: Effect.Effect<ReadonlyArray<FakeLaunch>>;
	// What each t3_thread_send T3 acted on asked for, oldest first; a repeated clientRequestId is left out.
	readonly sends: Effect.Effect<ReadonlyArray<SendInput>>;
	// While set, every call fails as T3 answers a revoked or re-minted token: HTTP 401.
	readonly rejectToken: (rejected: boolean) => Effect.Effect<void>;
	// While set, no call is answered, as when T3 hangs; the call policy times them out.
	readonly hang: (hanging: boolean) => Effect.Effect<void>;
	// The tools called, oldest first; a call made while the token is rejected or T3 hangs counts too.
	readonly calls: Effect.Effect<ReadonlyArray<string>>;
};

const latestRun = (thread: FakeThread) => Option.fromUndefinedOr(thread.runs.at(-1));

const statusOf = (thread: FakeThread): ThreadStatus => Option.match(latestRun(thread), { onNone: () => 'idle', onSome: (run) => run.status });

const activeRun = (thread: FakeThread) => Option.filter(latestRun(thread), (run) => !isTerminalRunStatus(run.status));

const runIdOf = (threadId: string, ordinal: number) => `run:thread:${threadId}:ordinal:${ordinal}`;

const summaryOf = (thread: FakeThread): ThreadSummary => ({
	threadId: thread.threadId,
	title: thread.title,
	status: statusOf(thread),
	latestRunId: Option.getOrNull(Option.map(latestRun(thread), (run) => run.runId)),
	settled: thread.settled,
	parentThreadId: thread.parentThreadId,
	relationshipToParent: thread.relationshipToParent,
	createdAt: thread.createdAt,
	updatedAt: thread.updatedAt,
});

// A token shaped like those scripts/mint-t3-token.sh writes: base64url JSON claims, a dot, then a signature.
export const t3TokenExpiring = (expiresAt: number) =>
	`${Buffer.from(JSON.stringify({ v: 1, kind: 'session', sid: 'f3a1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b', sub: 'mcp-client', iat: expiresAt - 3650 * 86_400_000, exp: expiresAt, rtc: 'full-access' })).toString('base64url')}.c2lnbmF0dXJl`;

const threadNotFound = (tool: string, threadId: string) => new T3ToolFailure({ tool, code: 'thread_not_found', message: `Thread ${threadId} is no longer available.` });

const unauthorized = new T3Unauthorized({ message: 'T3 answered HTTP 401: {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}' });

// Behaves like T3 Code's MCP tools for a caller outside any T3 thread: projects with unique workspace roots, threads
// whose runs move on through `setRunStatus`, subagent children, settling, and waits that return once the run is
// terminal or time out on the clock. Every call goes through the live layer's call policy, and a launch reads the
// default model from T3Config's settings file as the live layer does.
export class FakeT3 extends Context.Service<FakeT3, FakeT3Controls>()('sapphire-agent/FakeT3') {
	private static readonly needingSettings = Layer.effectContext(
		Effect.gen(function* () {
			const state = yield* SubscriptionRef.make<State>({ projects: [], threads: [] });
			const rejected = yield* Ref.make(false);
			const hanging = yield* Ref.make(false);
			const calls = yield* Ref.make<ReadonlyArray<string>>([]);
			const { settingsFile } = yield* T3Config;
			const fs = yield* FileSystem.FileSystem;
			const launches = yield* Ref.make<ReadonlyArray<FakeLaunch>>([]);
			const launchOutcome = yield* Ref.make<LaunchOutcome | null>(null);
			const ids = yield* Ref.make(0);
			const nextId = (prefix: string) => Ref.updateAndGet(ids, (n) => n + 1).pipe(Effect.map((n) => `${prefix}-${n}`));
			const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

			// What T3 sees of a call before running it: the token, then whether it answers at all. Other fibers run while
			// a call is on its way, as they do while one is on the network.
			const answer = <A>(tool: string, call: Effect.Effect<A, T3Error>) =>
				Effect.gen(function* () {
					yield* Ref.update(calls, (all) => [...all, tool]);
					yield* Effect.yieldNow;

					if (yield* Ref.get(rejected)) {
						return yield* unauthorized;
					}

					if (yield* Ref.get(hanging)) {
						return yield* Effect.never;
					}

					return yield* call;
				});

			const findThread = (tool: string, threadId: string) =>
				SubscriptionRef.get(state).pipe(
					Effect.flatMap(({ threads }) => Option.match(Option.fromUndefinedOr(threads.find((thread) => thread.threadId === threadId)), { onNone: () => Effect.fail(threadNotFound(tool, threadId)), onSome: Effect.succeed })),
				);

			const putThread = (thread: FakeThread) =>
				SubscriptionRef.update(state, ({ projects, threads }) => ({ projects, threads: threads.some((other) => other.threadId === thread.threadId) ? threads.map((other) => (other.threadId === thread.threadId ? thread : other)) : [...threads, thread] }));

			const changeThread = (tool: string, threadId: string, change: (thread: FakeThread, at: string) => FakeThread) =>
				Effect.gen(function* () {
					const thread = yield* findThread(tool, threadId);
					const changed = change(thread, yield* now);

					yield* putThread({ ...changed, updatedAt: yield* now });

					return changed;
				});

			const withItem = (thread: FakeThread, item: Omit<FakeItem, 'itemId'>): FakeThread => ({
				...thread,
				items: [...thread.items, { ...item, itemId: `item-${thread.threadId}-${thread.items.length}` }],
			});

			const withRun = (thread: FakeThread, status: RunStatus, message: string, at: string): FakeThread => {
				const runId = runIdOf(thread.threadId, thread.runs.length + 1);

				return withItem({ ...thread, runs: [...thread.runs, { runId, status, message, requestedAt: at }] }, { runId, type: 'user_message', text: message, updatedAt: at });
			};

			const setLatest = (thread: FakeThread, status: RunStatus): FakeThread => ({ ...thread, runs: thread.runs.map((run, index) => (index === thread.runs.length - 1 ? { ...run, status } : run)) });

			const addProject = (workspaceRoot: string, title = basename(workspaceRoot)) =>
				Effect.gen(function* () {
					const project: T3Project = { id: yield* nextId('project'), title, workspaceRoot };

					yield* SubscriptionRef.update(state, ({ projects, threads }) => ({ projects: [...projects, project], threads }));

					return project;
				});

			const newThread = (projectId: string, title: string, parent: Option.Option<FakeThread>) =>
				Effect.gen(function* () {
					const at = yield* now;

					return {
						threadId: yield* nextId('thread'),
						projectId,
						title,
						runs: [],
						items: [],
						pendingRequestCount: 0,
						settled: false,
						parentThreadId: Option.getOrNull(Option.map(parent, (thread) => thread.threadId)),
						relationshipToParent: Option.isSome(parent) ? 'subagent' : null,
						worktreePath: null,
						branch: null,
						createdAt: at,
						updatedAt: at,
					} satisfies FakeThread;
				});

			const matches = (filter: ThreadFilter) => (thread: FakeThread) =>
				thread.projectId === filter.projectId &&
				(filter.statuses === undefined || filter.statuses.includes(statusOf(thread))) &&
				(filter.settled === undefined || thread.settled === filter.settled) &&
				(filter.includeSubagents !== false || thread.relationshipToParent !== 'subagent') &&
				(filter.titleContains === undefined || thread.title.toLocaleLowerCase().includes(filter.titleContains.toLocaleLowerCase()));

			// What the requests T3 dedupes by clientRequestId answered.
			const sends = new Map<string, Sent>();
			const sent = yield* Ref.make<ReadonlyArray<SendInput>>([]);
			const interrupts = new Map<string, Interrupted>();

			const once = <A>(answered: Map<string, A>, clientRequestId: string, call: Effect.Effect<A, T3Error>) =>
				Effect.suspend(() => {
					const earlier = answered.get(clientRequestId);

					return earlier === undefined ? call.pipe(Effect.tap((result) => Effect.sync(() => answered.set(clientRequestId, result)))) : Effect.succeed(earlier);
				});

			const t3 = T3.of({
				ping: answer('ping', Effect.void).pipe(t3Policy.once),

				listProjects: answer('t3_project_list', SubscriptionRef.get(state).pipe(Effect.map(({ projects }) => projects))).pipe(t3Policy.call),

				createProject: ({ title, workspaceRoot }) =>
					answer(
						't3_project_create',
						Effect.gen(function* () {
							if ((yield* SubscriptionRef.get(state)).projects.some((project) => project.workspaceRoot === workspaceRoot)) {
								return yield* new T3ToolFailure({ tool: 't3_project_create', code: 'invalid_request', message: 'The workspace is already registered to a project.' });
							}

							return yield* addProject(workspaceRoot, title);
						}),
					).pipe(t3Policy.once),

				launchThread: (input) =>
					defaultModelSelection(settingsFile).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.flatMap((modelSelection) =>
							answer(
								't3_thread_launch',
								Effect.gen(function* () {
									const { projectId, title, message, workspaceStrategy } = input;

									yield* Ref.update(launches, (all) => [...all, { ...input, modelSelection }]);

									if (!(yield* SubscriptionRef.get(state)).projects.some((project) => project.id === projectId)) {
										return yield* new T3ToolFailure({ tool: 't3_thread_launch', code: 'invalid_request', message: `Project ${projectId} was not found.` });
									}

									const outcome = yield* Ref.get(launchOutcome);

									if (outcome !== null && 'code' in outcome) {
										return yield* new T3ToolFailure({ tool: 't3_thread_launch', ...outcome });
									}

									const created = yield* newThread(projectId, title, Option.none());
									const bound: FakeThread =
										workspaceStrategy?.type === 'existing_worktree'
											? { ...created, worktreePath: workspaceStrategy.worktreePath, branch: workspaceStrategy.branch ?? null }
											: { ...created, branch: workspaceStrategy?.branch ?? null };
									const thread = message === undefined ? bound : withRun(bound, outcome?.status ?? 'preparing', message, created.createdAt);

									yield* putThread(thread);

									const run = latestRun(thread);

									return { threadId: thread.threadId, projectId, runId: Option.getOrNull(Option.map(run, ({ runId }) => runId)), status: Option.getOrNull(Option.map(run, ({ status }) => status)) };
								}),
							).pipe(t3Policy.once),
						),
					),

				listThreads: (filter) =>
					answer('t3_thread_list', SubscriptionRef.get(state).pipe(Effect.map(({ threads }) => threads.filter(matches(filter)).reverse().map(summaryOf)))).pipe(t3Policy.call),

				readThread: ({ threadId, afterPosition = -1, limit = 50 }) =>
					answer(
						't3_thread_read',
						findThread('t3_thread_read', threadId).pipe(
							Effect.map((thread): ThreadRead => {
								const page = thread.items.filter((_, position) => position > afterPosition).slice(0, limit);

								return {
									thread: {
										...summaryOf(thread),
										projectId: thread.projectId,
										worktreePath: thread.worktreePath,
										itemCount: thread.items.length,
										pendingRequestCount: thread.pendingRequestCount,
									},
									items: page.map(({ type, updatedAt }) => ({ type, updatedAt })),
								};
							}),
						),
					).pipe(t3Policy.call),

				waitThread: ({ threadId, runId, timeoutMs }) =>
					answer(
						't3_thread_wait',
						Effect.gen(function* () {
							const target = (thread: FakeThread) => (runId === undefined ? latestRun(thread) : Option.fromUndefinedOr(thread.runs.find((run) => run.runId === runId)));
							const waited = (thread: FakeThread, timedOut: boolean) => {
								const run = target(thread);

								return { threadId, runId: Option.getOrNull(Option.map(run, (found) => found.runId)), status: Option.match(run, { onNone: (): ThreadStatus => 'idle', onSome: (found) => found.status }), timedOut };
							};
							const isDone = (thread: FakeThread) => Option.match(target(thread), { onNone: () => true, onSome: (run) => isTerminalRunStatus(run.status) });
							const thread = yield* findThread('t3_thread_wait', threadId);

							if (runId !== undefined && Option.isNone(target(thread))) {
								return yield* new T3ToolFailure({ tool: 't3_thread_wait', code: 'run_not_found', message: `Run ${runId} was not found.` });
							}

							const done = yield* SubscriptionRef.changes(state).pipe(
								Stream.map(({ threads }) => threads.find((candidate) => candidate.threadId === threadId)),
								Stream.filter((candidate): candidate is FakeThread => candidate !== undefined && isDone(candidate)),
								Stream.runHead,
								Effect.timeoutOption(timeoutMs),
								Effect.map(Option.flatten),
							);

							return Option.match(done, { onSome: (finished) => waited(finished, false), onNone: () => waited(thread, true) });
						}),
					).pipe(t3Policy.wait(timeoutMs)),

				sendThread: (input) =>
					answer(
						't3_thread_send',
						once(
							sends,
							input.clientRequestId,
							Effect.gen(function* () {
								const { threadId, message, mode = 'auto' } = input;
								const thread = yield* findThread('t3_thread_send', threadId);
								const active = activeRun(thread);
								const at = yield* now;

								if (Option.isNone(active) && mode === 'steer') {
									return yield* new T3ToolFailure({ tool: 't3_thread_send', code: 'thread_not_sendable', message: `Thread ${threadId} has no active run to steer.` });
								}

								yield* Ref.update(sent, (all) => [...all, input]);

								if (Option.isSome(active) && (mode === 'auto' || mode === 'steer')) {
									yield* putThread({ ...withItem(thread, { runId: active.value.runId, type: 'user_message', text: message, updatedAt: at }), updatedAt: at });

									return { threadId, runId: active.value.runId, status: active.value.status, delivery: 'steered' } satisfies Sent;
								}

								const restarted = mode === 'restart' && Option.isSome(active) ? setLatest(thread, 'interrupted') : thread;
								const queued = mode === 'queue' && Option.isSome(active);
								const changed = withRun(restarted, queued ? 'queued' : 'starting', message, at);

								yield* putThread({ ...changed, updatedAt: at });

								const run = changed.runs[changed.runs.length - 1];

								return { threadId, runId: run.runId, status: run.status, delivery: queued ? 'queued' : mode === 'restart' && Option.isSome(active) ? 'restarted' : 'started' } satisfies Sent;
							}),
						),
					).pipe(t3Policy.call),

				interruptThread: ({ threadId, runId, clientRequestId }) =>
					answer(
						't3_thread_interrupt',
						once(
							interrupts,
							clientRequestId,
							Effect.gen(function* () {
								const thread = yield* findThread('t3_thread_interrupt', threadId);
								const run = runId === undefined ? activeRun(thread) : Option.fromUndefinedOr(thread.runs.find((candidate) => candidate.runId === runId));

								if (Option.isNone(run)) {
									return { threadId, runId: null, status: 'no_active_run' } satisfies Interrupted;
								}

								const { status } = run.value;

								if (isTerminalRunStatus(status)) {
									return { threadId, runId: run.value.runId, status } satisfies Interrupted;
								}

								yield* changeThread('t3_thread_interrupt', threadId, (current) => ({ ...current, runs: current.runs.map((candidate) => (candidate.runId === run.value.runId ? { ...candidate, status: 'interrupted' } : candidate)) }));

								return { threadId, runId: run.value.runId, status: 'interrupt_requested' } satisfies Interrupted;
							}),
						),
					).pipe(t3Policy.call),

				organizeThread: ({ threadId }) =>
					answer(
						't3_thread_organize',
						changeThread('t3_thread_organize', threadId, (thread) => ({ ...thread, settled: true })),
					).pipe(Effect.asVoid, t3Policy.call),
			});

			const controls: FakeT3Controls = {
				addProject,
				projects: SubscriptionRef.get(state).pipe(Effect.map(({ projects }) => projects)),
				thread: (threadId) => SubscriptionRef.get(state).pipe(Effect.map(({ threads }) => Option.fromUndefinedOr(threads.find((thread) => thread.threadId === threadId)))),
				addSubagent: (parentThreadId, title, status) =>
					Effect.gen(function* () {
						const parent = yield* findThread('addSubagent', parentThreadId).pipe(Effect.orDie);
						const child = withRun(yield* newThread(parent.projectId, title, Option.some(parent)), status, title, yield* now);

						yield* putThread(child);

						return child.threadId;
					}),
				setRunStatus: (threadId, status) => changeThread('setRunStatus', threadId, (thread) => setLatest(thread, status)).pipe(Effect.orDie, Effect.asVoid),
				setWorktreePath: (threadId, path) => changeThread('setWorktreePath', threadId, (thread) => ({ ...thread, worktreePath: path })).pipe(Effect.orDie, Effect.asVoid),
				addActivity: (threadId) =>
					changeThread('addActivity', threadId, (thread, at) =>
						withItem(thread, { runId: Option.getOrNull(Option.map(latestRun(thread), ({ runId }) => runId)), type: 'command_execution', text: '$ npm test', updatedAt: at }),
					).pipe(Effect.orDie, Effect.asVoid),
				updateLastItem: (threadId) =>
					Effect.gen(function* () {
						const thread = yield* findThread('updateLastItem', threadId);
						const at = yield* now;

						yield* putThread({ ...thread, items: thread.items.map((item, index) => (index === thread.items.length - 1 ? { ...item, updatedAt: at } : item)) });
					}).pipe(Effect.orDie),
				setPendingRequests: (threadId, count) => changeThread('setPendingRequests', threadId, (thread) => ({ ...thread, pendingRequestCount: count })).pipe(Effect.orDie, Effect.asVoid),
				setSettled: (threadId, settled) => changeThread('setSettled', threadId, (thread) => ({ ...thread, settled })).pipe(Effect.orDie, Effect.asVoid),
				setLaunchOutcome: (outcome) => Ref.set(launchOutcome, outcome),
				launches: Ref.get(launches),
				sends: Ref.get(sent),
				rejectToken: (value) => Ref.set(rejected, value),
				hang: (value) => Ref.set(hanging, value),
				calls: Ref.get(calls),
			};

			return Context.make(T3, t3).pipe(Context.add(FakeT3, controls));
		}),
	);

	// Launches read the settings file given, by default T3's settings as recorded from the live server.
	static readonly layer = (settingsFile?: string) => FakeT3.needingSettings.pipe(Layer.provide(Layer.mergeAll(T3Config.layerTest(settingsFile), NodeFileSystem.layer)));
}
