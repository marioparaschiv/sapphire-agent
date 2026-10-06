import { Clock, Effect, Option } from 'effect';
import type { CallError } from './call-policy.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { adoptTab, claimedRun, repoOf, runsClaude } from './dispatch.ts';
import { Git, type Worktree } from './git.ts';
import { GitHub } from './github.ts';
import { Herdr, type WorkspaceTab } from './herdr.ts';
import { Journal, newSession, type Run } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { epicWithIdentifier, hasRole, identifierOfBranch, isAgentWorking, isFinished, type Observation } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Projects } from './projects.ts';
import { makeTabActions } from './run-actions.ts';

// Everything cleanup found for one epic this tick.
type Found = { readonly epic: Epic; readonly run: Option.Option<Run>; readonly tabs: Array<WorkspaceTab>; readonly worktrees: Array<Worktree> };

const isTrackedTab = (runs: ReadonlyArray<Run>, tab: WorkspaceTab) => runs.some((run) => run.tabId === tab.tabId || run.paneId === tab.paneId);

const isTrackedWorktree = (runs: ReadonlyArray<Run>, worktree: Worktree) =>
	runs.some((run) => run.worktreePath === worktree.path || (run.repo === worktree.repo && run.branch === worktree.branch));

// Ends what is left of a run once its epic shipped or its PR was merged or closed (or, for a ready epic's run that never started,
// once it ended): its tab, then its worktree and local branch, then its row. Work that is not on origin keeps the
// worktree and the epic is told once; it is removed on a later tick once pushed or discarded. Also resolves owned
// tabs and worktrees that no run tracks.
export const cleanupRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const projects = yield* Projects;
	const journal = yield* Journal;
	const git = yield* Git;
	const github = yield* GitHub;
	const herdr = yield* Herdr;
	const linear = yield* Linear;
	const comments = yield* Comments;
	const { closeRunTab } = yield* makeTabActions;

	const isDue = (observation: Observation, run: Run, epic: Epic): Effect.Effect<boolean, CallError> => {
		if (run.status === 'claimed') {
			return Effect.succeed(false);
		}

		if (hasRole(observation, epic, ['shipped'])) {
			return Effect.succeed(true);
		}

		// A follow-up that never started still has the previous run's worktree and PR.
		if (run.startedAt === null && run.job._tag === 'orchestrate') {
			return Effect.succeed(run.status === 'ended' || run.status === 'kept');
		}

		return git.githubRepo(run.repo).pipe(
			Effect.flatMap((repo) => github.findPullRequest(repo, run.branch)),
			Effect.map(Option.exists((pullRequest) => pullRequest.state === 'MERGED' || pullRequest.state === 'CLOSED')),
		);
	};

	const cleanUpRun = (observation: Observation, run: Run, epic: Epic) =>
		Effect.gen(function* () {
			// Closing a working agent's tab would kill it mid-turn; the next tick looks again.
			if (!(yield* isDue(observation, run, epic)) || isAgentWorking(observation, run)) {
				return;
			}

			yield* closeRunTab(observation, run);

			if (run.worktreePath === null) {
				yield* journal.deleteRun(run.epicId);

				return yield* Effect.log('nothing to clean up; dropped the run');
			}

			const worktree = { repo: run.repo, branch: run.branch, path: run.worktreePath };
			const unsaved = yield* git.unsavedWork(worktree);

			if (Option.isSome(unsaved)) {
				if (run.status !== 'kept') {
					yield* Effect.log(`kept ${worktree.path}: ${unsaved.value}`);
					yield* linear.comment(
						run.epicId,
						comments.keptWorktree({ identifier: run.identifier, claimedAt: Option.some(run.claimedAt), worktreePath: worktree.path, reason: unsaved.value }),
					);
					yield* journal.putRun({ ...run, status: 'kept' });
				}

				return;
			}

			yield* git.removeWorktree(worktree);
			yield* journal.deleteRun(run.epicId);
			yield* Effect.log(`removed ${worktree.path} and branch ${worktree.branch}; dropped the run`);
		});

	// The first untracked tab of an active epic without a run becomes its run; the start rule confirms it. Any other
	// is closed once its agent is not working. A working one is flagged and left running.
	const resolveTabs = (observation: Observation, epic: Epic, run: Option.Option<Run>, tabs: ReadonlyArray<WorkspaceTab>) =>
		Effect.gen(function* () {
			// A claim whose tab was opened just before a crash: the start rule adopts it.
			if (tabs.length === 0 || Option.exists(run, (found) => found.status === 'claimed' && found.tabId === null)) {
				return;
			}

			let rest = tabs;

			if (Option.isNone(run) && hasRole(observation, epic, ['ready', 'implementing', 'inReview'])) {
				const [first, ...others] = tabs;
				const repo = yield* repoOf(config, projects, epic);
				// Claude already in the tab runs in a session sapphire-agent never recorded. Without Claude, the start rule starts
				// it in the new one.
				const session = runsClaude(Option.some(first)) ? null : yield* newSession(epic.identifier);
				const adopted = adoptTab(claimedRun(epic, repo, yield* Clock.currentTimeMillis, session), first);

				yield* journal.putRun({ ...adopted, worktreePath: git.worktreePath(repo, epic.branchName) });
				yield* Effect.log(`adopted untracked tab ${first.tabId}`);
				rest = others;
			}

			for (const tab of rest) {
				if (tab.agentStatus === 'working') {
					yield* linear.comment(epic.id, comments.workingOrphan({ identifier: epic.identifier, tabLabel: tab.label, tabId: tab.tabId, paneId: tab.paneId }));
					continue;
				}

				if (yield* herdr.closeTab(tab.tabId)) {
					yield* Effect.log(`closed untracked tab ${tab.tabId}`);
				}
			}
		});

	const resolveWorktrees = (epic: Epic, worktrees: ReadonlyArray<Worktree>) =>
		Effect.forEach(
			worktrees,
			(worktree) =>
				Effect.gen(function* () {
					const unsaved = yield* git.unsavedWork(worktree);

					if (Option.isSome(unsaved)) {
						return yield* linear.comment(
							epic.id,
							comments.keptWorktree({ identifier: epic.identifier, claimedAt: Option.none(), worktreePath: worktree.path, reason: unsaved.value }),
						);
					}

					yield* git.removeWorktree(worktree);
					yield* Effect.log(`removed untracked ${worktree.path} and branch ${worktree.branch}`);
				}),
			{ discard: true },
		);

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const work: Array<EpicWork> = [];
			const found = new Map<string, Found>();

			const entry = (epic: Epic) => {
				const existing = found.get(epic.id);

				if (existing) {
					return existing;
				}

				const created: Found = { epic, run: Option.fromUndefinedOr(runs.find((run) => run.epicId === epic.id)), tabs: [], worktrees: [] };

				found.set(epic.id, created);

				return created;
			};

			for (const run of runs.filter((candidate) => observation.teams.has(candidate.teamId))) {
				const epic = observation.epics.get(run.epicId);

				if (epic) {
					entry(epic);
					continue;
				}

				work.push({
					epicId: run.epicId,
					identifier: run.identifier,
					teamId: run.teamId,
					apply: journal.deleteRun(run.epicId).pipe(Effect.andThen(Effect.log('the epic no longer exists; dropped the run'))),
				});
			}

			// Only tabs and worktrees of an epic in a resolved team count as owned; anything else is left alone.
			const ownedEpic = (identifier: string) => Option.filter(epicWithIdentifier(observation, identifier), (epic) => observation.teams.has(epic.team.id));

			for (const tab of observation.tabs.filter((candidate) => !isTrackedTab(runs, candidate))) {
				const epic = Option.flatMap(tab.identifier, ownedEpic);

				if (Option.isSome(epic)) {
					entry(epic.value).tabs.push(tab);
				}
			}

			for (const worktree of observation.worktrees.filter((candidate) => !isTrackedWorktree(runs, candidate))) {
				const epic = Option.filter(
					Option.flatMap(identifierOfBranch(worktree.branch), ownedEpic),
					// Built the way sapphire-agent builds its worktrees, for an epic whose work is over. herdr's own worktrees
					// use the same layout, so a worktree of an epic still in progress is never touched.
					(candidate) =>
						candidate.branchName === worktree.branch &&
						git.worktreePath(worktree.repo, worktree.branch) === worktree.path &&
						isFinished(observation, candidate) &&
						!runs.some((run) => run.epicId === candidate.id),
				);

				if (Option.isSome(epic)) {
					entry(epic.value).worktrees.push(worktree);
				}
			}

			for (const { epic, run, tabs, worktrees } of found.values()) {
				const apply = Effect.gen(function* () {
					if (Option.isSome(run)) {
						yield* cleanUpRun(observation, run.value, epic);
					}

					yield* resolveTabs(observation, epic, run, tabs);
					yield* resolveWorktrees(epic, worktrees);
				});

				work.push({ epicId: epic.id, identifier: epic.identifier, teamId: epic.team.id, apply });
			}

			return work;
		});

	return { name: 'cleanup', pausable: false, plan } satisfies Rule;
});
