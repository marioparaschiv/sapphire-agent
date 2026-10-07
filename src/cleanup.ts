import { Clock, Effect, Option } from 'effect';
import type { CallError } from './call-policy.ts';
import { Comments } from './comments.ts';
import { Git, type Worktree } from './git.ts';
import { GitHub } from './github.ts';
import { Journal, type Run } from './journal.ts';
import type { Epic } from './linear.ts';
import { epicWithIdentifier, hasRole, identifierOfBranch, isAgentWorking, isFinished, type Observation } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Pushover, sendOrLog } from './pushover.ts';
import { makeSettle } from './run-actions.ts';
import { hasActiveRun, T3 } from './t3.ts';

// The run is over; commits of its merged PR's head count as on origin.
type Ending = { readonly mergedHead: Option.Option<string> };

// Everything cleanup found for one epic this tick.
type Found = { readonly epic: Epic; readonly run: Option.Option<Run>; readonly worktrees: Array<Worktree> };

const isTrackedWorktree = (runs: ReadonlyArray<Run>, worktree: Worktree) =>
	runs.some((run) => run.worktreePath === worktree.path || (run.repo === worktree.repo && run.branch === worktree.branch));

// Ends what is left of a run once its epic shipped or was canceled, or its PR was merged or closed (or, for a ready
// epic's run that never started, once it ended): its T3 thread is settled (unless T3 auto-settled it), then its
// worktree and local branch removed, and its row dropped. Work that is not on origin keeps the worktree and the user is
// told once, on the epic and by Pushover; it is removed on a later tick once pushed or discarded. Commits of a merged
// PR count as on origin, so a squash merge whose branch was deleted is no unpushed work. A thread the user un-settled
// after that is left alone with its worktree. Also resolves owned worktrees that no run tracks.
export const cleanupRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const git = yield* Git;
	const github = yield* GitHub;
	const comments = yield* Comments;
	const t3 = yield* T3;
	const pushover = yield* Pushover;
	const settle = yield* makeSettle;

	// Whether the run is over: none while it goes on, else the head of its merged PR, if any, whose commits are on
	// origin even once a squash merge left them on no origin branch.
	const ending = (observation: Observation, run: Run, epic: Epic): Effect.Effect<Option.Option<Ending>, CallError> => {
		if (run.status === 'claimed') {
			return Effect.succeedNone;
		}

		if (hasRole(observation, epic, ['shipped']) || isFinished(observation, epic)) {
			return Effect.succeed(Option.some({ mergedHead: Option.none() }));
		}

		// A follow-up that never started still has the previous run's worktree and PR.
		if (run.startedAt === null && run.job._tag === 'orchestrate') {
			return Effect.succeed(run.status === 'ended' || run.status === 'kept' ? Option.some({ mergedHead: Option.none() }) : Option.none());
		}

		return git.githubRepo(run.repo).pipe(
			Effect.flatMap((repo) => github.findPullRequest(repo, run.branch)),
			Effect.map((found) =>
				Option.filter(found, (pullRequest) => pullRequest.state === 'MERGED' || pullRequest.state === 'CLOSED').pipe(
					Option.map((pullRequest) => ({ mergedHead: pullRequest.state === 'MERGED' ? Option.some(pullRequest.headRefOid) : Option.none() })),
				),
			),
		);
	};

	// One notice on the epic and one on the phone.
	const tellKept = (epic: Epic, kept: { readonly claimedAt: Option.Option<number>; readonly worktreePath: string; readonly reason: string }) =>
		Effect.gen(function* () {
			if (yield* journal.addNotice(comments.keptWorktree({ identifier: epic.identifier, ...kept }))) {
				yield* sendOrLog(pushover, {
					title: `Kept ${epic.identifier}'s worktree`,
					message: `${kept.worktreePath} has ${kept.reason}. Push or discard that work; the worktree is removed on a later poll.`,
					url: epic.url,
					priority: 'normal',
				});
			}
		});

	// Settles a T3 run's thread unless T3 settled it already, and says whether cleanup may go on: not while the thread
	// works, nor once the user un-settled a thread that was settled, which they are using again.
	const settleThread = (run: Run, threadId: string) =>
		Effect.gen(function* () {
			const read = yield* t3.readThread({ threadId, limit: 1 }).pipe(
				Effect.map(Option.some),
				Effect.catchTag('T3ToolFailure', (error) => (error.code === 'thread_not_found' ? Effect.succeedNone : Effect.fail(error))),
			);

			if (Option.isNone(read)) {
				return Option.some(run);
			}

			const { status, settled } = read.value.thread;

			if (hasActiveRun(status)) {
				return Option.none();
			}

			if (!settled && run.threadSettledAt !== null) {
				yield* Effect.logDebug(`T3 thread ${threadId} was un-settled; leaving it alone`);

				return Option.none();
			}

			if (!settled) {
				yield* settle(threadId);
			}

			if (run.threadSettledAt !== null) {
				return Option.some(run);
			}

			const recorded: Run = { ...run, threadSettledAt: yield* Clock.currentTimeMillis };

			yield* journal.putRun(recorded);

			return Option.some(recorded);
		});

	const cleanUpRun = (observation: Observation, due: Run, epic: Epic) =>
		Effect.gen(function* () {
			// A working agent is left to finish its turn; the next tick looks again.
			if (isAgentWorking(observation, due)) {
				return;
			}

			const ended = yield* ending(observation, due, epic);

			if (Option.isNone(ended)) {
				return;
			}

			const settled = due.threadId === null ? Option.some(due) : yield* settleThread(due, due.threadId);

			if (Option.isNone(settled)) {
				return;
			}

			const run = settled.value;

			if (run.worktreePath === null) {
				yield* journal.deleteRun(run.epicId);

				return yield* Effect.log('nothing to clean up; dropped the run');
			}

			const worktree = { repo: run.repo, branch: run.branch, path: run.worktreePath };
			const unsaved = yield* git.unsavedWork(worktree, Option.getOrUndefined(ended.value.mergedHead));

			if (Option.isSome(unsaved)) {
				if (run.status !== 'kept') {
					yield* Effect.log(`kept ${worktree.path}: ${unsaved.value}`);
					yield* tellKept(epic, { claimedAt: Option.some(run.claimedAt), worktreePath: worktree.path, reason: unsaved.value });
					yield* journal.putRun({ ...run, status: 'kept' });
				}

				return;
			}

			yield* git.removeWorktree(worktree);
			yield* journal.deleteRun(run.epicId);
			yield* Effect.log(`removed ${worktree.path} and branch ${worktree.branch}; dropped the run`);
		});

	const resolveWorktrees = (epic: Epic, worktrees: ReadonlyArray<Worktree>) =>
		Effect.forEach(
			worktrees,
			(worktree) =>
				Effect.gen(function* () {
					const unsaved = yield* git.unsavedWork(worktree);

					if (Option.isSome(unsaved)) {
						return yield* tellKept(epic, { claimedAt: Option.none(), worktreePath: worktree.path, reason: unsaved.value });
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

				const created: Found = { epic, run: Option.fromUndefinedOr(runs.find((run) => run.epicId === epic.id)), worktrees: [] };

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

			// Only worktrees of an epic in a resolved team count as owned; anything else is left alone.
			const ownedEpic = (identifier: string) => Option.filter(epicWithIdentifier(observation, identifier), (epic) => observation.teams.has(epic.team.id));

			for (const worktree of observation.worktrees.filter((candidate) => !isTrackedWorktree(runs, candidate))) {
				const epic = Option.filter(
					Option.flatMap(identifierOfBranch(worktree.branch), ownedEpic),
					// Built the way T3 builds sapphire-agent's worktrees, for an epic whose work is over. A worktree of an epic
					// still in progress is never touched.
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

			for (const { epic, run, worktrees } of found.values()) {
				const apply = Effect.gen(function* () {
					if (Option.isSome(run)) {
						yield* cleanUpRun(observation, run.value, epic);
					}

					yield* resolveWorktrees(epic, worktrees);
				});

				work.push({ epicId: epic.id, identifier: epic.identifier, teamId: epic.team.id, apply });
			}

			return work;
		});

	return { name: 'cleanup', pausable: false, plan } satisfies Rule;
});
