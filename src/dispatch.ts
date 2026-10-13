import { join } from 'node:path';
import { Clock, Effect, Option, Result } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import { Comments } from './comments.ts';
import { AppConfig, type AppConfigShape } from './config.ts';
import { Git } from './git.ts';
import { GitHub, type PullRequest } from './github.ts';
import { Journal, type Job, newSession, type Project, type Run, type Session } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { activeRoles, hasRole, heldBy, isInFlight, isOver, type Observation, observedWorktreePath, roleOf, stuckLabelOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Projects } from './projects.ts';
import { Prompts } from './prompts.ts';
import { makeFlag, makeInterrupt } from './run-actions.ts';
import { hasActiveRun, hasFailedRun, T3, type T3ToolFailure, type WorkspaceStrategy } from './t3.ts';
import { T3Projects } from './t3-projects.ts';

const repoNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The local clone an epic runs in: its project's repo, or `<labelReposDirectory>/<name>` for an epic labelled
// `<repoPrefix><name>` or labelled `<name>` inside the label group named like the prefix (Linear shows `repo/<name>`).
const resolveRepo = (config: AppConfigShape, { repo, labelReposDirectory }: Project, epic: Epic): Result.Result<string, string> => {
	const prefix = config.labels.repoPrefix;
	const group = prefix.replace(/:$/, '');
	const names = epic.labels.nodes.flatMap((label) => {
		if (label.name.startsWith(prefix)) {
			return [label.name.slice(prefix.length)];
		}

		return label.parent?.name === group ? [label.name] : [];
	});

	if (names.length === 0) {
		return Result.succeed(repo);
	}

	if (names.length > 1) {
		return Result.fail(`the epic has more than one repo label: ${names.join(', ')}`);
	}

	const [name] = names;

	if (labelReposDirectory === null) {
		return Result.fail(`the epic is labelled ${prefix}${name}, but project ${epic.team.name} has no label repos directory`);
	}

	if (!repoNamePattern.test(name)) {
		return Result.fail(`${JSON.stringify(name)} is not a valid repo name`);
	}

	return Result.succeed(join(labelReposDirectory, name));
};

const repoOf = (config: AppConfigShape, projects: Projects['Service'], epic: Epic) =>
	projects.get(epic.team.name).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(new Permanent({ message: `team ${epic.team.name} is not a project` })),
				onSome: (project) => Result.match(resolveRepo(config, project, epic), { onFailure: (message) => Effect.fail(new Permanent({ message })), onSuccess: Effect.succeed }),
			}),
		),
	);

// A run recorded before anything is started for it. The start rule takes it from here.
export const claimedRun = (epic: Epic, repo: string, claimedAt: number, session: Session | null, job: Job = { _tag: 'orchestrate' }): Run => ({
	epicId: epic.id,
	identifier: epic.identifier,
	teamId: epic.team.id,
	status: 'claimed',
	job,
	repo,
	branch: epic.branchName,
	worktreePath: null,
	session,
	replyTo: null,
	claimedAt,
	startedAt: null,
	agentStatus: null,
	agentStatusSince: null,
	nudgedAt: null,
	result: null,
	handoff: null,
	threadId: null,
	threadRunId: null,
	threadSettledAt: null,
});

// Claims ready epics up to maxInFlight, in Linear's order: a top-level epic in the ready state of a resolved team,
// without the stuck label, created at least dispatchSettleSeconds ago, not held by an issue blocking it, and with no run
// or only one that is over.
export const dispatchRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const projects = yield* Projects;

	// The newest start request names the session the run replies to; the claim drops them all.
	const claim = (epic: Epic, starts: ReadonlyArray<{ readonly id: number; readonly replyTo: string | null }>) =>
		Effect.gen(function* () {
			const repo = yield* repoOf(config, projects, epic);
			const replyTo = starts.at(-1)?.replyTo ?? null;

			yield* journal.claimRun(
				{ ...claimedRun(epic, repo, yield* Clock.currentTimeMillis, yield* newSession(epic.identifier)), replyTo },
				starts.map(({ id }) => id),
			);
			yield* Effect.log(`claimed for ${repo} on ${epic.branchName}`);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const requests = yield* journal.listRequests;
			const now = yield* Clock.currentTimeMillis;
			const candidates = observation.ready
				.filter((epic) => {
					const run = runs.find((candidate) => candidate.epicId === epic.id);
					const settled = now - Date.parse(epic.createdAt) >= config.dispatchSettleSeconds * 1000;

					return observation.teams.has(epic.team.id) && Option.isNone(stuckLabelOf(config, epic)) && settled && heldBy(epic).length === 0 && (!run || isOver(run));
				})
				.toSorted((a, b) => a.sortOrder - b.sortOrder);
			let inFlight = runs.filter(isInFlight).length;
			const work: Array<EpicWork> = [];

			for (const epic of candidates) {
				if (inFlight >= config.maxInFlight) {
					break;
				}

				inFlight += 1;

				const starts = requests.flatMap(({ id, request }) => (request._tag === 'start' && request.identifier === epic.identifier ? [{ id, replyTo: request.replyTo }] : []));

				work.push({ epicId: epic.id, identifier: epic.identifier, teamId: epic.team.id, apply: claim(epic, starts) });
			}

			return work;
		});

	return { name: 'dispatch', pausable: true, plan } satisfies Rule;
});

const refusedByT3 = (error: T3ToolFailure) => new Permanent({ message: `T3 refused ${error.tool}: ${error.message} (${error.code})` });

// Takes each claimed run through its T3 thread and the move to implementing. The thread is recorded before the move,
// and a thread T3 has for the claim is not launched again, so after a crash the next tick carries on where it stopped.
// Not paused, so a claim made before a pause still starts. Also records the worktree of a run once T3 made it.
export const startRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const git = yield* Git;
	const linear = yield* Linear;
	const github = yield* GitHub;
	const prompts = yield* Prompts;
	const comments = yield* Comments;
	const t3 = yield* T3;
	const t3Projects = yield* T3Projects;
	const flag = yield* makeFlag;
	const interrupt = yield* makeInterrupt;
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
			? Effect.succeed(epic.children.nodes.length === 0 ? prompts.inline(epic, run.replyTo) : prompts.orchestrate(epic, run.replyTo))
			: Effect.map(pullRequestOf(run), (pullRequest) => prompts.followUp(epic, { pullRequestUrl: pullRequest.url, threadIds: job.threadIds, instruction: job.instruction }));
	};

	// A follow-up that never started goes back to ended in To Review: its worktree is still cleaned up, and a new follow-up
	// request starts a new one once the label is removed.
	const failStart = (observation: Observation, run: Run, epic: Epic, error: string) =>
		Effect.gen(function* () {
			yield* Effect.logError(`failed to start: ${error}`);
			yield* flag(observation, run, comments.startFailed({ identifier: run.identifier, claimedAt: run.claimedAt, error }));
			yield* interrupt(run, 'the start failed', `start-failed-${run.claimedAt}`);

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

	// A thread T3 has for the epic already: one launched for this claim (e.g. just before a crash), or one still working.
	// An older thread that is done belongs to an earlier run.
	const existingThread = (run: Run, projectId: string) =>
		t3.listThreads({ projectId, titleContains: run.identifier, includeSubagents: false }).pipe(
			Effect.map((threads) =>
				Option.fromUndefinedOr(
					threads.find(
						(thread) =>
							thread.title.startsWith(`${run.identifier} `) &&
							(Date.parse(thread.createdAt) >= run.claimedAt || hasActiveRun(thread.status)),
					),
				),
			),
		);

	const worktreeOnBranch = (observation: Observation, run: Run) =>
		Option.map(Option.fromUndefinedOr(observation.worktrees.find((worktree) => worktree.repo === run.repo && worktree.branch === run.branch)), ({ path }) => path);

	// A follow-up works in the epic's worktree (restored from origin if it was cleaned up), pulled up to date. A new run
	// reuses a worktree already on the branch, otherwise T3 makes one from the default branch as fetched from origin.
	const workspaceFor = (observation: Observation, run: Run): Effect.Effect<{ readonly worktreePath: string | null; readonly workspaceStrategy: WorkspaceStrategy }, CallError> =>
		Effect.gen(function* () {
			const existing = run.job._tag === 'follow-up' ? Option.some(yield* git.prepareWorktree(run.repo, run.branch)) : worktreeOnBranch(observation, run);

			if (Option.isNone(existing)) {
				return { worktreePath: null, workspaceStrategy: { type: 'worktree', baseRef: yield* git.defaultBranch(run.repo), branch: run.branch, startFromOrigin: true } };
			}

			const worktree = { repo: run.repo, branch: run.branch, path: existing.value };

			if (run.job._tag === 'follow-up') {
				yield* git.pull(worktree);
			}

			yield* git.removeResultFile(worktree);

			return { worktreePath: worktree.path, workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree.path, branch: run.branch } };
		});

	const launch = (observation: Observation, run: Run, epic: Epic, projectId: string) =>
		Effect.gen(function* () {
			const { worktreePath, workspaceStrategy } = yield* workspaceFor(observation, run);
			const message = yield* promptFor(run, epic);

			yield* Effect.log(`launching a T3 thread in project ${projectId}`);

			const launched = yield* t3.launchThread({ projectId, title: prompts.threadTitle(epic, 1), message, workspaceStrategy, runtimeMode: 'full-access' });

			return { threadId: launched.threadId, threadRunId: launched.runId, worktreePath, status: launched.status };
		});

	const markRunning = (observation: Observation, run: Run, epic: Epic) =>
		Effect.gen(function* () {
			const team = observation.teams.get(run.teamId);

			if (team && !Option.contains(roleOf(observation, epic), 'implementing')) {
				yield* linear.moveIssue(epic.id, team.stateIds.implementing);
			}

			const started: Run = { ...run, status: 'running', startedAt: yield* Clock.currentTimeMillis };

			yield* journal.putRun(started);

			return started;
		});

	const start = (observation: Observation, claimed: Run, epic: Epic) => {
		let run = claimed;

		// The thread is recorded before anything else, so a crash after the launch never launches a second one.
		const steps = Effect.gen(function* () {
			if (run.threadId === null) {
				const projectId = yield* t3Projects.projectFor(run.repo);
				const found = yield* existingThread(run, projectId);
				const thread = yield* Option.match(found, {
					onNone: () => launch(observation, run, epic, projectId),
					onSome: (summary) =>
						Effect.log(`adopting T3 thread ${summary.threadId}`).pipe(
							Effect.as({
								threadId: summary.threadId,
								threadRunId: summary.latestRunId,
								worktreePath: run.worktreePath ?? Option.getOrNull(worktreeOnBranch(observation, run)),
								status: summary.status,
							}),
						),
				});

				run = { ...run, threadId: thread.threadId, threadRunId: thread.threadRunId, worktreePath: thread.worktreePath };
				yield* journal.putRun(run);

				if (hasFailedRun(thread.status)) {
					return yield* new Permanent({ message: `the run of T3 thread ${thread.threadId} ended at once: ${thread.status}` });
				}
			}

			run = yield* markRunning(observation, run, epic);
			yield* Effect.log(`agent started in T3 thread ${run.threadId}`);
		}).pipe(Effect.catchTag('T3ToolFailure', (error) => Effect.fail(refusedByT3(error))));

		return Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;

			if (now - Math.max(claimed.claimedAt, bootedAt) >= config.startTimeoutSeconds * 1000) {
				return yield* failStart(observation, claimed, epic, `the agent was not confirmed running within ${config.startTimeoutSeconds} s`);
			}

			yield* steps.pipe(Effect.catchTag('Permanent', (error) => failStart(observation, run, epic, error.message)));
		});
	};

	// T3 makes a new worktree after the launch answered, so its path is recorded once T3 reports it.
	const recordWorktree = (observation: Observation, run: Run) =>
		Option.map(Option.fromNullishOr(observedWorktreePath(observation, run)), (worktreePath) =>
			journal.putRun({ ...run, worktreePath }).pipe(Effect.andThen(Effect.log(`T3 made the worktree ${worktreePath}`))),
		);

	const plan = (observation: Observation) =>
		journal.listRuns.pipe(
			Effect.map((runs) =>
				runs.flatMap((run): Array<EpicWork> => {
					const epic = observation.epics.get(run.epicId);
					const work = { epicId: run.epicId, identifier: run.identifier, teamId: run.teamId };

					if (run.status !== 'claimed') {
						return run.worktreePath === null && isInFlight(run) ? Option.toArray(Option.map(recordWorktree(observation, run), (apply) => ({ ...work, apply }))) : [];
					}

					if (!epic || !observation.teams.has(run.teamId) || !hasRole(observation, epic, activeRoles(run))) {
						return [];
					}

					return [{ ...work, apply: start(observation, run, epic) }];
				}),
			),
		);

	return { name: 'start', pausable: false, plan } satisfies Rule;
});
