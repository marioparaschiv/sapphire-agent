import { Context, Effect, Layer, Option, Record, Struct } from 'effect';
import type { CallError } from './call-policy.ts';
import { AppConfig, type AppConfigShape, type StateRole } from './config.ts';
import { Git, type Worktree } from './git.ts';
import { Herdr, type WorkspaceTab } from './herdr.ts';
import { type AgentStatus, Journal, type JournalError, type Run, type RunStatus } from './journal.ts';
import { type Epic, Linear, type Team } from './linear.ts';

// A configured team found in Linear with every configured workflow state.
export type ResolvedTeam = { readonly team: Team; readonly stateIds: Readonly<Record<StateRole, string>> };

// What one tick sees of the world outside the journal, read once at its start and shared by every rule. Rules read the
// journal themselves when they plan: it is local and cheap, and so each rule sees what the rules before it wrote this
// tick. A rule that takes over a tab checks herdr first, since a rule before it may have closed that tab this tick.
export type Observation = {
	// By team id. A configured team missing from Linear, or missing a state, is left out: its epics are not touched.
	readonly teams: ReadonlyMap<string, ResolvedTeam>;
	// By epic id: every epic the journal tracks (a run or a chat thread), every ready epic, and the epics of owned tabs and worktrees.
	readonly epics: ReadonlyMap<string, Epic>;
	// Top-level epics in a team's ready state, at most 50.
	readonly ready: ReadonlyArray<Epic>;
	// Every tab in the sapphire-agent workspace, renamed ones included.
	readonly tabs: ReadonlyArray<WorkspaceTab>;
	// Every worktree under the worktrees directory of a configured or tracked repo, herdr's own included.
	readonly worktrees: ReadonlyArray<Worktree>;
};

// Runs whose agent may still be alive. They hold a maxInFlight slot, so live agents never exceed it.
const inFlightStatuses: ReadonlyArray<RunStatus> = ['claimed', 'running', 'awaitingInput', 'stale'];

export const isInFlight = (run: Run) => inFlightStatuses.includes(run.status);

// A finished run's row is replaced by a new claim, and so is a run that never started once its label is removed.
export const isOver = (run: Run) => run.status === 'ended' || run.status === 'kept' || (run.status === 'error' && run.startedAt === null);

// A run that got as far as a tab in a worktree has all of these.
export type StartedRun = Run & { readonly worktreePath: string; readonly tabId: string; readonly paneId: string };

export const isStarted = (run: Run): run is StartedRun => run.worktreePath !== null && run.tabId !== null && run.paneId !== null;

// A run whose agent can be sent a message (`send` requests).
export const acceptsMessages = (run: Run) => isInFlight(run) && isStarted(run);

// A run that was never confirmed running belongs in the ready state, or in To Review for a follow-up (or in
// implementing, once the start moved it); a started run in implementing or in review. Elsewhere its tab is closed.
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

// Done, canceled and the like: the epic's work is over.
export const isFinished = (observation: Observation, epic: Epic) => {
	const state = observation.teams.get(epic.team.id)?.team.states.nodes.find((candidate) => candidate.id === epic.state.id);

	return state?.type === 'completed' || state?.type === 'canceled';
};

export const epicWithIdentifier = (observation: Observation, identifier: string) =>
	Option.fromUndefinedOr([...observation.epics.values()].find((epic) => epic.identifier === identifier));

// What a run or a command records of its tab.
export type TabIds = Pick<Run, 'tabId' | 'paneId'>;

// The run's own tab: herdr can hand a closed tab's id to a new one, so the pane must match too. The label may differ.
export const tabOf = (observation: Observation, run: TabIds) =>
	Option.fromUndefinedOr(observation.tabs.find((tab) => tab.tabId === run.tabId && tab.paneId === run.paneId));

// vanished: the run's tab is gone. exited: the pane is left without Claude.
export const observedAgentStatus = (observation: Observation, run: TabIds): AgentStatus =>
	Option.match(tabOf(observation, run), {
		onNone: () => 'vanished',
		onSome: (tab) => (Option.contains(tab.agent, 'claude') ? tab.agentStatus : 'exited'),
	});

// A stale agent only claims to be working.
export const isAgentWorking = (observation: Observation, run: Run) => run.status !== 'stale' && observedAgentStatus(observation, run) === 'working';

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

const resolveTeams = (config: AppConfigShape, teams: ReadonlyArray<Team>, warn: (message: string) => Effect.Effect<void>) =>
	Effect.gen(function* () {
		const resolved = new Map<string, ResolvedTeam>();

		for (const name of Object.keys(config.teams)) {
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
			const herdr = yield* Herdr;
			const git = yield* Git;
			const journal = yield* Journal;
			const warnOnce = makeWarnOnce();

			// A repo that cannot be listed only skips its orphan worktrees; everything else goes on.
			const listWorktrees = (repo: string) =>
				git.listWorktrees(repo).pipe(Effect.catch((error) => warnOnce(`cannot list the worktrees of ${repo}: ${error.message}`).pipe(Effect.as([]))));

			const observe = Effect.gen(function* () {
				const teams = yield* resolveTeams(config, yield* linear.teams(Object.keys(config.teams)), warnOnce);
				const runs = yield* journal.listRuns;
				const topics = yield* journal.listTopics;
				const repos = [...new Set([...Object.values(config.teams).map((team) => team.repo), ...runs.map((run) => run.repo)])];
				const [ready, tracked, tabs, worktrees] = yield* Effect.all(
					[
						linear.readyEpics([...teams.values()].map(({ stateIds }) => stateIds.ready)),
						linear.epics([...new Set([...runs, ...topics].map(({ epicId }) => epicId))]),
						herdr.workspaceTabs,
						Effect.forEach(repos, listWorktrees, { concurrency: 'unbounded' }).pipe(Effect.map((lists) => lists.flat())),
					],
					{ concurrency: 'unbounded' },
				);
				const known = new Set([...ready, ...tracked].map((epic) => epic.identifier));
				const unknown = [
					...new Set([
						...tabs.flatMap((tab) => Option.toArray(tab.identifier)),
						...worktrees.flatMap((worktree) => Option.toArray(identifierOfBranch(worktree.branch))),
					]),
				].filter((identifier) => !known.has(identifier));
				const others = yield* linear.epicsByIdentifier(unknown);

				return {
					teams,
					epics: new Map([...tracked, ...ready, ...others].map((epic) => [epic.id, epic])),
					ready,
					tabs,
					worktrees,
				};
			});

			return Observer.of({ observe });
		}),
	);
}
