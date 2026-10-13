import { Context, Effect, Layer, Option, Record, Struct } from 'effect';
import type { CallError } from './call-policy.ts';
import { AppConfig, type AppConfigShape, type StateRole } from './config.ts';
import { Git, type Worktree } from './git.ts';
import { Journal, type JournalError, type Project, type Run, type RunStatus } from './journal.ts';
import { type Epic, Linear, type ReadyEpic, type Team } from './linear.ts';
import { Projects } from './projects.ts';
import { hasActiveRun, T3, type ThreadRead, type ThreadStatus, type ThreadSummary } from './t3.ts';

// A project's team found in Linear with every configured workflow state.
export type ResolvedTeam = { readonly team: Team; readonly stateIds: Readonly<Record<StateRole, string>> };

// What one tick sees of the world outside the journal, read once at its start and shared by every rule. Rules read the
// journal themselves when they plan: it is local and cheap, and so each rule sees what the rules before it wrote this
// tick.
export type Observation = {
	// By team id. A project's team missing from Linear, or missing a state, is left out: its epics are not touched.
	readonly teams: ReadonlyMap<string, ResolvedTeam>;
	// By epic id: every epic the journal has a run of, every ready epic, and the epics of owned worktrees.
	readonly epics: ReadonlyMap<string, Epic>;
	// Top-level epics in a team's ready state, at most 50.
	readonly ready: ReadonlyArray<ReadyEpic>;
	// Every worktree under the worktrees directory of a configured or tracked repo.
	readonly worktrees: ReadonlyArray<Worktree>;
	// By thread id: the T3 thread of every run that is not over. A thread T3 no longer has is left out.
	readonly threads: ReadonlyMap<string, ObservedThread>;
};

// unknown: T3 could not be asked this tick.
export type ObservedThread = {
	readonly status: ThreadStatus | 'unknown';
	readonly title: string | null;
	readonly worktreePath: string | null;
	// Questions and approvals waiting for the user.
	readonly pendingRequests: number;
	// The newest updatedAt of the thread, its latest timeline items and its subagents' threads, in epoch ms; none when
	// T3 could not be asked.
	readonly lastProgressAt: number | null;
	// The same, of what the agent did itself: its latest timeline items but the messages sent to it, and its subagents'
	// threads. A message, or the run it starts, is no sign the agent got going.
	readonly lastAgentActivityAt: number | null;
};

// What a stalled run's progress is read from: its newest few timeline items.
const recentItems = 5;

// Epoch ms; 0 for nothing.
const newest = (changed: ReadonlyArray<{ readonly updatedAt: string }>) => Math.max(0, ...changed.map(({ updatedAt }) => Date.parse(updatedAt)));

// A subagent's thread counts as its parent's progress, and so do the subagents it started.
const descendants = (threads: ReadonlyArray<ThreadSummary>, threadId: string): ReadonlyArray<ThreadSummary> =>
	threads.filter((thread) => thread.parentThreadId === threadId).flatMap((child) => [child, ...descendants(threads, child.threadId)]);

type ThreadReading =
	| { readonly _tag: 'Read'; readonly threadId: string; readonly read: ThreadRead }
	| { readonly _tag: 'Gone'; readonly threadId: string }
	| { readonly _tag: 'Unknown'; readonly threadId: string };

// Runs whose agent may still be alive. They hold a maxInFlight slot, so live agents never exceed it.
const inFlightStatuses: ReadonlyArray<RunStatus> = ['claimed', 'running', 'stale'];

export const isInFlight = (run: Run) => inFlightStatuses.includes(run.status);

// A project is not removed while a run of its team is in flight.
export const hasRunInFlight = (runs: ReadonlyArray<Run>, teamId: string) => runs.some((run) => run.teamId === teamId && isInFlight(run));

// A finished run's row is replaced by a new claim, and so is a run that never started once its label is removed.
export const isOver = (run: Run) => run.status === 'ended' || run.status === 'kept' || (run.status === 'error' && run.startedAt === null);

// A run whose T3 thread was launched, once T3 made its worktree.
export type ThreadedRun = Run & { readonly worktreePath: string; readonly threadId: string };

export const isThreaded = (run: Run): run is ThreadedRun => run.threadId !== null && run.worktreePath !== null && run.startedAt !== null;

// A run whose agent can be sent a message (`send` requests).
export const acceptsMessages = (run: Run): run is Run & { readonly threadId: string } => isInFlight(run) && run.threadId !== null && run.startedAt !== null;

// Whether `cwd` is the directory or inside it, as a hook reports where its agent works.
export const isInside = (directory: string, cwd: string) => cwd === directory || cwd.startsWith(`${directory}/`);

// A run that was never confirmed running belongs in the ready state, or in To Review for a follow-up (or in
// implementing, once the start moved it); a started run in implementing or in review. Elsewhere it is ended.
export const activeRoles = (run: Run): ReadonlyArray<StateRole> => {
	if (run.startedAt !== null) {
		return ['implementing', 'inReview'];
	}

	return run.job._tag === 'follow-up' ? ['toReview', 'implementing'] : ['ready', 'implementing'];
};

export const roleOf = (observation: Observation, epic: Epic): Option.Option<StateRole> => {
	const team = observation.teams.get(epic.team.id);

	if (!team) {
		return Option.none();
	}

	return Option.fromUndefinedOr(Struct.keys(team.stateIds).find((role) => team.stateIds[role] === epic.state.id));
};

export const hasRole = (observation: Observation, epic: Epic, roles: ReadonlyArray<StateRole>) =>
	Option.match(roleOf(observation, epic), { onNone: () => false, onSome: (role) => roles.includes(role) });

const isFinishedStateType = (type: string | undefined) => type === 'completed' || type === 'canceled';

// Done, canceled and the like: the epic's work is over.
export const isFinished = (observation: Observation, epic: Epic) =>
	isFinishedStateType(observation.teams.get(epic.team.id)?.team.states.nodes.find((candidate) => candidate.id === epic.state.id)?.type);

// The identifiers of the issues, in any team, that block the epic and are not completed or canceled yet. The epic is
// held in its ready state until there are none.
export const heldBy = (epic: ReadyEpic) =>
	epic.inverseRelations.nodes.flatMap(({ type, issue }) => (type === 'blocks' && !isFinishedStateType(issue.state.type) ? [issue.identifier] : []));

export const epicWithIdentifier = (observation: Observation, identifier: string) =>
	Option.fromUndefinedOr([...observation.epics.values()].find((epic) => epic.identifier === identifier));

// A run works while its thread does.
export const isAgentWorking = (observation: Observation, run: Run) => {
	const thread = run.threadId === null ? undefined : observation.threads.get(run.threadId);

	// A thread whose status is unknown may be working, so nothing ends it.
	return thread !== undefined && (thread.status === 'unknown' || hasActiveRun(thread.status));
};

// The worktree of a T3 run, which T3 makes after the launch answered: recorded on the run once seen, else as T3 reports
// it this tick.
export const observedWorktreePath = (observation: Observation, run: Run) =>
	run.worktreePath ?? (run.threadId === null ? null : (observation.threads.get(run.threadId)?.worktreePath ?? null));

export const stuckLabelOf = (config: AppConfigShape, epic: Epic) => Option.fromUndefinedOr(epic.labels.nodes.find((label) => label.name === config.labels.stuck));

// Linear names branches `<user>/<identifier>-<slug>`.
export const identifierOfBranch = (branch: string) => Option.map(Option.fromNullishOr(/(?:^|\/)([a-z]+-\d+)(?:-|$)/i.exec(branch)?.[1]), (identifier) => identifier.toUpperCase());

// Configuration problems repeat every tick; once per process is enough.
export const makeWarnOnce = () => {
	const warned = new Set<string>();

	return (message: string) =>
		Effect.suspend(() => {
			if (warned.has(message)) {
				return Effect.void;
			}

			warned.add(message);

			return Effect.logWarning(message);
		});
};

const resolveTeams = (config: AppConfigShape, projects: ReadonlyArray<Project>, teams: ReadonlyArray<Team>, warn: (message: string) => Effect.Effect<void>) =>
	Effect.gen(function* () {
		const resolved = new Map<string, ResolvedTeam>();

		for (const { team: name } of projects) {
			const team = teams.find((candidate) => candidate.name === name);

			if (!team) {
				yield* warn(`team ${name} not found in Linear; skipping it`);
				continue;
			}

			const stateIds = Record.map(config.states, (stateName) => Option.fromUndefinedOr(team.states.nodes.find((state) => state.name === stateName)?.id));
			const all = Option.all(stateIds);

			if (Option.isNone(all)) {
				const missing = Struct.keys(stateIds).filter((role) => Option.isNone(stateIds[role]));

				yield* warn(`team ${name} has no workflow state ${missing.map((role) => JSON.stringify(config.states[role])).join(', ')}; skipping it until it does`);
				continue;
			}

			resolved.set(team.id, { team, stateIds: all.value });
		}

		return resolved;
	});

export class Observer extends Context.Service<Observer, { readonly observe: Effect.Effect<Observation, CallError | JournalError> }>()('sapphire-agent/Observer') {
	static readonly layer = Layer.effect(
		Observer,
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const linear = yield* Linear;
			const git = yield* Git;
			const journal = yield* Journal;
			const projects = yield* Projects;
			const t3 = yield* T3;
			const warnOnce = makeWarnOnce();

			// A repo that cannot be listed only skips its orphan worktrees; everything else goes on.
			const listWorktrees = (repo: string) =>
				git.listWorktrees(repo).pipe(Effect.catch((error) => warnOnce(`cannot list the worktrees of ${repo}: ${error.message}`).pipe(Effect.as([]))));

			// The thread and its newest timeline items. Positions run from 0, so the newest come after itemCount - 1 - recentItems.
			const readRecent = (threadId: string) =>
				Effect.gen(function* () {
					const first = yield* t3.readThread({ threadId, view: 'activity', limit: 1 });
					const { itemCount } = first.thread;

					if (itemCount <= 1) {
						return first;
					}

					return yield* t3.readThread({ threadId, view: 'activity', limit: recentItems, ...(itemCount > recentItems ? { afterPosition: itemCount - recentItems - 1 } : {}) });
				});

			// T3 being unreachable only leaves the thread unknown; everything else goes on. A thread T3 no longer has is left
			// out.
			const observeThreads = (threadIds: ReadonlyArray<string>): Effect.Effect<ReadonlyMap<string, ObservedThread>> =>
				Effect.gen(function* () {
					const reads = yield* Effect.forEach(
						threadIds,
						(threadId) =>
							readRecent(threadId).pipe(
								Effect.map((read): ThreadReading => ({ _tag: 'Read', threadId, read })),
								Effect.catchTag('T3ToolFailure', (error) => (error.code === 'thread_not_found' ? Effect.succeed<ThreadReading>({ _tag: 'Gone', threadId }) : Effect.fail(error))),
								Effect.catch((error) => Effect.logWarning(`cannot read T3 thread ${threadId}: ${error.message}`).pipe(Effect.as<ThreadReading>({ _tag: 'Unknown', threadId }))),
							),
						{ concurrency: 'unbounded' },
					);
					const projectIds = [...new Set(reads.flatMap((reading) => (reading._tag === 'Read' ? [reading.read.thread.projectId] : [])))];
					// Subagents run unsettled; none when T3 could not list them.
					const projectThreads = new Map(
						yield* Effect.forEach(
							projectIds,
							(projectId) =>
								t3.listThreads({ projectId, settled: false }).pipe(
									Effect.map((threads) => [projectId, threads] as const),
									Effect.catch((error) => Effect.logWarning(`cannot list the threads of T3 project ${projectId}: ${error.message}`).pipe(Effect.as([projectId, null] as const))),
								),
							{ concurrency: 'unbounded' },
						),
					);

					return new Map(
						reads.flatMap((reading): ReadonlyArray<readonly [string, ObservedThread]> => {
							switch (reading._tag) {
								case 'Gone':
									return [];
								case 'Unknown':
									return [[reading.threadId, { status: 'unknown', title: null, worktreePath: null, pendingRequests: 0, lastProgressAt: null, lastAgentActivityAt: null }]];
								case 'Read': {
									const { thread, items } = reading.read;
									const threads = projectThreads.get(thread.projectId);
									const subagents = threads === undefined || threads === null ? null : descendants(threads, thread.threadId);
									const agentItems = items.filter(({ type }) => type !== 'user_message');

									return [
										[
											reading.threadId,
											{
												status: thread.status,
												title: thread.title,
												worktreePath: thread.worktreePath,
												pendingRequests: thread.pendingRequestCount,
												lastProgressAt: subagents === null ? null : newest([thread, ...items, ...subagents]),
												lastAgentActivityAt: subagents === null ? null : newest([...agentItems, ...subagents]),
											},
										],
									];
								}
							}
						}),
					);
				});

			const observe = Effect.gen(function* () {
				const watched = yield* projects.list;
				const teams = yield* resolveTeams(config, watched, yield* linear.teams(watched.map(({ team }) => team)), warnOnce);
				const runs = yield* journal.listRuns;
				const repos = [...new Set([...watched.map(({ repo }) => repo), ...runs.map((run) => run.repo)])];
				const threadIds = runs.flatMap((run) => (run.threadId === null || isOver(run) ? [] : [run.threadId]));
				const [ready, tracked, worktrees, threads] = yield* Effect.all(
					[
						linear.readyEpics([...teams.values()].map(({ stateIds }) => stateIds.ready)),
						linear.epics([...new Set(runs.map(({ epicId }) => epicId))]),
						Effect.forEach(repos, listWorktrees, { concurrency: 'unbounded' }).pipe(Effect.map((lists) => lists.flat())),
						observeThreads(threadIds),
					],
					{ concurrency: 'unbounded' },
				);
				const known = new Set([...ready, ...tracked].map((epic) => epic.identifier));
				const unknown = [...new Set(worktrees.flatMap((worktree) => Option.toArray(identifierOfBranch(worktree.branch))))].filter((identifier) => !known.has(identifier));
				const others = yield* linear.epicsByIdentifier(unknown);

				return {
					teams,
					epics: new Map([...tracked, ...ready, ...others].map((epic) => [epic.id, epic])),
					ready,
					worktrees,
					threads,
				};
			});

			return Observer.of({ observe });
		}),
	);
}
