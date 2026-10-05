import { join } from 'node:path';
import { Clock, Effect, Option, Result, Semaphore } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import { ClaudeTrust } from './claude-trust.ts';
import { Comments } from './comments.ts';
import { AppConfig, type AppConfigShape } from './config.ts';
import { Git } from './git.ts';
import { GitHub, type PullRequest } from './github.ts';
import { Herdr, type OpenedTab, type Pane } from './herdr.ts';
import { Journal, type Job, type Run } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { activeRoles, hasRole, isInFlight, type Observation, roleOf, stuckLabelOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Prompts } from './prompts.ts';
import { makeFlag } from './run-actions.ts';

const repoNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The local clone an epic runs in: its team's repo, or `<labelReposDirectory>/<name>` for an epic labelled
// `<repoPrefix><name>` or labelled `<name>` inside the label group named like the prefix (Linear shows `repo/<name>`).
const resolveRepo = (config: AppConfigShape, epic: Epic): Result.Result<string, string> => {
	const team = config.teams[epic.team.name];

	if (!team) {
		return Result.fail(`team ${epic.team.name} has no repo in the config`);
	}

	const prefix = config.labels.repoPrefix;
	const group = prefix.replace(/:$/, '');
	const names = epic.labels.nodes.flatMap((label) => {
		if (label.name.startsWith(prefix)) {
			return [label.name.slice(prefix.length)];
		}

		return label.parent?.name === group ? [label.name] : [];
	});

	if (names.length === 0) {
		return Result.succeed(team.repo);
	}

	if (names.length > 1) {
		return Result.fail(`the epic has more than one repo label: ${names.join(', ')}`);
	}

	const [name] = names;

	if (!team.labelReposDirectory) {
		return Result.fail(`the epic is labelled ${prefix}${name}, but team ${epic.team.name} has no labelReposDirectory`);
	}

	if (!repoNamePattern.test(name)) {
		return Result.fail(`${JSON.stringify(name)} is not a valid repo name`);
	}

	return Result.succeed(join(team.labelReposDirectory, name));
};

export const repoOf = (config: AppConfigShape, epic: Epic) =>
	Result.match(resolveRepo(config, epic), { onFailure: (message) => Effect.fail(new Permanent({ message })), onSuccess: Effect.succeed });

// A run recorded before anything is started for it. The start rule takes it from here.
export const claimedRun = (epic: Epic, repo: string, claimedAt: number, job: Job = { _tag: 'orchestrate' }): Run => ({
	epicId: epic.id,
	identifier: epic.identifier,
	teamId: epic.team.id,
	status: 'claimed',
	job,
	repo,
	branch: epic.branchName,
	worktreePath: null,
	tabId: null,
	paneId: null,
	claimedAt,
	startedAt: null,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	tailHash: null,
	result: null,
	questionCommentId: null,
	deliveredReplyIds: [],
});

// Takes over a tab that is already open for the run, e.g. one opened just before a crash.
export const adoptTab = (run: Run, tab: OpenedTab): Run => ({ ...run, tabId: tab.tabId, paneId: tab.paneId });

// An owned tab of the epic that no run tracks yet.
const adoptableTab = (observation: Observation, runs: ReadonlyArray<Run>, identifier: string) =>
	Option.fromUndefinedOr(
		observation.tabs.find(
			(tab) => Option.contains(tab.identifier, identifier) && !runs.some((run) => run.tabId === tab.tabId || run.paneId === tab.paneId),
		),
	);

// A finished run's row is replaced by a new claim, and so is a run that never started once its label is removed.
const isOver = (run: Run) => run.status === 'ended' || run.status === 'kept' || (run.status === 'error' && run.startedAt === null);

// Claims ready epics up to maxInFlight, in Linear's order: a top-level epic in the ready state of a resolved team,
// without the stuck label, and with no run or only one that is over.
export const dispatchRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;

	const claim = (epic: Epic) =>
		Effect.gen(function* () {
			const repo = yield* repoOf(config, epic);

			yield* journal.putRun(claimedRun(epic, repo, yield* Clock.currentTimeMillis));
			yield* Effect.log(`claimed for ${repo} on ${epic.branchName}`);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const candidates = observation.ready
				.filter((epic) => {
					const run = runs.find((candidate) => candidate.epicId === epic.id);

					return observation.teams.has(epic.team.id) && Option.isNone(stuckLabelOf(config, epic)) && (!run || isOver(run));
				})
				.toSorted((a, b) => a.sortOrder - b.sortOrder);
			let inFlight = runs.filter(isInFlight).length;
			const work: Array<EpicWork> = [];

			for (const epic of candidates) {
				if (inFlight >= config.maxInFlight) {
					break;
				}

				inFlight += 1;
				work.push({ epicId: epic.id, identifier: epic.identifier, teamId: epic.team.id, apply: claim(epic) });
			}

			return work;
		});

	return { name: 'dispatch', pausable: true, plan } satisfies Rule;
});

export const runsClaude = (pane: Option.Option<Pane>) => Option.exists(pane, (found) => Option.contains(found.agent, 'claude'));

export const describeAgent = (pane: Option.Option<Pane>) =>
	Option.match(Option.flatMap(pane, (found) => Option.map(found.agent, (agent) => `${agent} is ${found.agentStatus}`)), {
		onNone: () => 'no agent is running',
		onSome: (state) => state,
	});

// Takes each claimed run through worktree, trust, tab, Claude and the move to implementing. Each step looks at what is
// already there, so after a crash the next tick carries on where it stopped: an existing worktree is reused, an owned
// tab of the epic is adopted, and Claude found in the pane is not started again. Not paused, so a claim made before a
// pause still starts.
export const startRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const git = yield* Git;
	const trust = yield* ClaudeTrust;
	const herdr = yield* Herdr;
	const linear = yield* Linear;
	const github = yield* GitHub;
	const prompts = yield* Prompts;
	const comments = yield* Comments;
	const flag = yield* makeFlag;
	// Starts race on ~/.claude.json and on creating the workspace.
	const starts = yield* Semaphore.make(1);
	// After a restart a claimed run gets a full start window again.
	const bootedAt = yield* Clock.currentTimeMillis;

	// The PR a follow-up works on, which its prompt names.
	const pullRequestOf = (run: Run): Effect.Effect<PullRequest, CallError> =>
		git.githubRepo(run.repo).pipe(
			Effect.flatMap((repo) => github.findPullRequest(repo, run.branch)),
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(new Permanent({ message: `branch ${run.branch} has no PR to follow up on` })),
					onSome: Effect.succeed,
				}),
			),
		);

	const promptFor = (run: Run, epic: Epic): Effect.Effect<string, CallError> => {
		const { job } = run;

		return job._tag === 'orchestrate'
			? Effect.succeed(epic.children.nodes.length === 0 ? prompts.inline(epic) : prompts.orchestrate(epic))
			: Effect.map(pullRequestOf(run), (pullRequest) => prompts.followUp(epic, { pullRequestUrl: pullRequest.url, threadIds: job.threadIds, instruction: job.instruction }));
	};

	// A follow-up that never started goes back to ended in To Review: its worktree is still cleaned up, and a new follow-up
	// request starts a new one once the label is removed.
	const failStart = (observation: Observation, run: Run, epic: Epic, error: string) =>
		Effect.gen(function* () {
			const tail = run.paneId === null ? Option.none<string>() : yield* herdr.readTail(run.paneId);

			yield* Effect.logError(`failed to start: ${error}`);
			yield* flag(observation, run, comments.startFailed({ identifier: run.identifier, claimedAt: run.claimedAt, error, tail }));

			if (run.job._tag === 'orchestrate') {
				return yield* journal.putRun({ ...run, status: 'error' });
			}

			const team = observation.teams.get(run.teamId);

			if (team && !Option.contains(roleOf(observation, epic), 'toReview')) {
				yield* linear.moveIssue(epic.id, team.stateIds.toReview);
			}

			// The previous run's worktree is still there even when the start failed before it was recorded.
			yield* journal.putRun({ ...run, status: 'ended', worktreePath: run.worktreePath ?? git.worktreePath(run.repo, run.branch) });
		});

	const start = (observation: Observation, runs: ReadonlyArray<Run>, claimed: Run, epic: Epic) => {
		let run = claimed;

		const prepare = Effect.gen(function* () {
			const path = yield* git.prepareWorktree(run.repo, run.branch);
			const worktree = { repo: run.repo, branch: run.branch, path };

			if (run.job._tag === 'follow-up') {
				yield* git.pull(worktree);
			}

			yield* git.removeResultFile(worktree);
			run = { ...run, worktreePath: path };
			yield* journal.putRun(run);

			return path;
		});

		const openTab = (path: string) =>
			Effect.gen(function* () {
				yield* trust.trustFolder(path);

				const found = adoptableTab(observation, runs, run.identifier);
				// The observation is from the start of the tick; an earlier rule may have closed the tab since.
				const live = Option.isSome(found) && Option.isSome(yield* herdr.pane(found.value.paneId)) ? found : Option.none();
				const tab = yield* Option.match(live, {
					onNone: () => herdr.openTab(prompts.tabLabel(epic), path),
					onSome: (adopted) => Effect.log(`adopting tab ${adopted.tabId}`).pipe(Effect.as(adopted)),
				});

				run = adoptTab(run, tab);
				yield* journal.putRun(run);

				return tab;
			});

		const steps = Effect.gen(function* () {
			const path = run.worktreePath ?? (yield* prepare);
			const { tabId, paneId } = run.tabId !== null && run.paneId !== null ? { tabId: run.tabId, paneId: run.paneId } : yield* openTab(path);
			if (!runsClaude(yield* herdr.agent(paneId))) {
				yield* Effect.log(`starting Claude in ${tabId} (${path})`);
				yield* herdr.startClaude(paneId, run.identifier.toLowerCase(), yield* promptFor(run, epic));

				const agent = yield* herdr.agent(paneId);

				if (!runsClaude(agent) || Option.exists(agent, (found) => found.agentStatus === 'blocked')) {
					return yield* new Permanent({ message: `Claude did not start in ${tabId}: ${describeAgent(agent)}` });
				}
			}

			const team = observation.teams.get(run.teamId);

			if (team && !Option.contains(roleOf(observation, epic), 'implementing')) {
				yield* linear.moveIssue(epic.id, team.stateIds.implementing);
			}

			run = { ...run, status: 'running', startedAt: yield* Clock.currentTimeMillis };
			yield* journal.putRun(run);
			yield* Effect.log(`agent started in tab ${tabId}`);
		});

		return Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;

			if (now - Math.max(claimed.claimedAt, bootedAt) >= config.startTimeoutSeconds * 1000) {
				return yield* failStart(observation, claimed, epic, `the agent was not confirmed running within ${config.startTimeoutSeconds} s`);
			}

			yield* starts.withPermit(steps).pipe(Effect.catchTag('Permanent', (error) => failStart(observation, run, epic, error.message)));
		});
	};

	const plan = (observation: Observation) =>
		journal.listRuns.pipe(
			Effect.map((runs) =>
				runs.flatMap((run): Array<EpicWork> => {
					const epic = observation.epics.get(run.epicId);

					if (run.status !== 'claimed' || !epic || !observation.teams.has(run.teamId) || !hasRole(observation, epic, activeRoles(run))) {
						return [];
					}

					return [{ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply: start(observation, runs, run, epic) }];
				}),
			),
		);

	return { name: 'start', pausable: false, plan } satisfies Rule;
});
