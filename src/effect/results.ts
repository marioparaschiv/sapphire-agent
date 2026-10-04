import { Effect, Option } from 'effect';
import type { CallError } from './call-policy.ts';
import { Comments, replyMismatch } from './comments.ts';
import { AppConfig } from './config.ts';
import { Git } from './git.ts';
import { GitHub, type PullRequest } from './github.ts';
import { Journal, type JournalError, type Run } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { activeRoles, hasRole, isAgentWorking, type Observation, roleOf, stuckLabelOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import type { ResultFile } from './result-file.ts';
import { makeFlag, makeTabActions } from './run-actions.ts';

// A run whose result is posted, or whose epic moved on, keeps a slot until then.
const watchedStatuses: ReadonlyArray<Run['status']> = ['claimed', 'running', 'awaitingInput', 'stale', 'error'];

// Hands finished runs over and ends runs whose epic moved on. Once the agent is not working: a run whose epic left its
// active states is ended (tab closed); otherwise a valid result file is stored, posted to the PR, the epic moves to
// To Review and the run is ended. Only the tab closes; the cleanup rule removes the worktree later.
export const resultsRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const git = yield* Git;
	const github = yield* GitHub;
	const linear = yield* Linear;
	const comments = yield* Comments;
	const flag = yield* makeFlag;
	const { endRun } = yield* makeTabActions;

	const fail = (run: Run): Effect.Effect<void, JournalError> => (run.status === 'error' ? Effect.void : journal.putRun({ ...run, status: 'error' }));

	// Every part of the result as a marked PR write, each skipped when its marker is already there (a resolved thread is
	// not resolved again). Once this returns, every part is on the PR.
	const postResult = (run: Run, result: ResultFile, repo: string, pullRequest: PullRequest): Effect.Effect<void, CallError> =>
		Effect.gen(function* () {
			const { identifier, claimedAt } = run;

			yield* github.postSummary(repo, pullRequest.number, comments.summary({ identifier, claimedAt, summary: result.summary, authorLogin: pullRequest.author.login }));

			if (result.flags.length > 0) {
				yield* github.postFlagsReview(repo, pullRequest.number, comments.flagsReview({ identifier, claimedAt }), result.flags);
			}

			for (const { threadId, body } of result.replies) {
				yield* github.replyToThread(threadId, comments.threadReply({ identifier, claimedAt, threadId, body }));
				yield* github.resolveThread(threadId);
			}
		});

	const finishRun = (observation: Observation, run: Run, result: ResultFile, epic: Epic) =>
		Effect.gen(function* () {
			const threadIds = run.job._tag === 'follow-up' ? run.job.threadIds : [];
			const mismatch = replyMismatch(threadIds, result.replies);

			if (Option.isSome(mismatch)) {
				yield* flag(observation, run, comments.threadMismatch({ identifier: run.identifier, claimedAt: run.claimedAt, job: run.job, mismatch: mismatch.value }));

				return yield* fail(run);
			}

			const repo = yield* git.githubRepo(run.repo);
			const pullRequest = Option.filter(yield* github.findPullRequest(repo, run.branch), (found) => found.state !== 'CLOSED');

			if (Option.isNone(pullRequest)) {
				yield* flag(observation, run, comments.noPullRequest({ identifier: run.identifier, claimedAt: run.claimedAt, branch: run.branch }));

				return yield* fail(run);
			}

			yield* postResult(run, result, repo, pullRequest.value);
			yield* Effect.log(`posted the result to ${pullRequest.value.url}`);

			const team = observation.teams.get(run.teamId);

			if (team && !Option.contains(roleOf(observation, epic), 'toReview')) {
				yield* linear.moveIssue(epic.id, team.stateIds.toReview);
			}

			const stuckLabel = stuckLabelOf(config, epic);

			if (Option.isSome(stuckLabel)) {
				yield* linear.removeLabel(epic.id, stuckLabel.value.id);
			}

			yield* endRun(observation, run, 'the agent finished');
		});

	// The agent writes the file as its last step, so it is read only once the agent stopped, never half-written.
	const readResult = (observation: Observation, run: Run, worktreePath: string, epic: Epic) =>
		git.readResultFile({ repo: run.repo, branch: run.branch, path: worktreePath }).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (result) =>
						journal.putRun({ ...run, result }).pipe(
							Effect.andThen(Effect.log('the agent wrote its result file')),
							Effect.andThen(finishRun(observation, { ...run, result }, result, epic)),
						),
				}),
			),
			Effect.catchTag('InvalidResultFile', (error) =>
				Effect.gen(function* () {
					yield* Effect.logError(`invalid result file: ${error.message}`);
					yield* flag(observation, run, comments.invalidResult({ identifier: run.identifier, claimedAt: run.claimedAt, error: error.message }));
					yield* fail(run);
				}),
			),
		);

	const workFor = (observation: Observation, run: Run, epic: Epic): Option.Option<Effect.Effect<void, unknown>> => {
		// Closing a working agent's tab would kill it mid-turn.
		if (isAgentWorking(observation, run)) {
			return Option.none();
		}

		if (!hasRole(observation, epic, activeRoles(run))) {
			return Option.some(endRun(observation, run, `the epic moved to ${epic.state.name}`));
		}

		if (run.result !== null) {
			return Option.some(finishRun(observation, run, run.result, epic));
		}

		// An errored run already had its result file read, or its agent never started.
		if (run.status === 'claimed' || run.status === 'error' || run.worktreePath === null) {
			return Option.none();
		}

		return Option.some(readResult(observation, run, run.worktreePath, epic));
	};

	const plan = (observation: Observation) =>
		journal.listRuns.pipe(
			Effect.map((runs) =>
				runs.flatMap((run): Array<EpicWork> => {
					const epic = observation.epics.get(run.epicId);

					if (!watchedStatuses.includes(run.status) || !epic || !observation.teams.has(run.teamId)) {
						return [];
					}

					return Option.toArray(Option.map(workFor(observation, run, epic), (apply) => ({ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply })));
				}),
			),
		);

	return { name: 'results', pausable: false, plan } satisfies Rule;
});
