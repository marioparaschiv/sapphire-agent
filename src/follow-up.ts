import { Clock, Effect, Option, Ref } from 'effect';
import { AppConfig } from './config.ts';
import { claimedRun } from './dispatch.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { Journal, type Run } from './journal.ts';
import type { Epic } from './linear.ts';
import { hasRole, isInFlight, type Observation, stuckLabelOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';

// One follow-up run per epic in To Review whose open PR has pending review threads, all of them batched, while
// maxInFlight allows. Only an ended run is scanned: an in-flight one already holds the epic, so a restart mid-run
// claims nothing twice. The claim replaces the ended run and the start rule takes it from there (pull, /follow-up).
export const followUpRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const git = yield* Git;
	const github = yield* GitHub;

	const claim = (run: Run, epic: Epic, freeSlots: Ref.Ref<number>) =>
		Effect.gen(function* () {
			const pending = Option.filter(
				yield* git.githubRepo(run.repo).pipe(Effect.flatMap((repo) => github.pendingThreads(repo, run.branch))),
				({ threadIds }) => threadIds.length > 0,
			);

			if (Option.isNone(pending)) {
				return;
			}

			const { url, threadIds } = pending.value;

			if (!(yield* Ref.modify(freeSlots, (free) => (free > 0 ? [true, free - 1] : [false, free])))) {
				return;
			}

			yield* journal.putRun(claimedRun(epic, run.repo, yield* Clock.currentTimeMillis, { _tag: 'follow-up', threadIds }));
			yield* Effect.log(`claimed a follow-up for ${threadIds.length} review threads on ${url}`);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const free = config.maxInFlight - runs.filter(isInFlight).length;

			if (free <= 0) {
				return [];
			}

			const freeSlots = yield* Ref.make(free);

			return runs.flatMap((run): Array<EpicWork> => {
				const epic = observation.epics.get(run.epicId);

				if (run.status !== 'ended' || !epic || !observation.teams.has(run.teamId) || !hasRole(observation, epic, ['toReview']) || Option.isSome(stuckLabelOf(config, epic))) {
					return [];
				}

				return [{ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply: claim(run, epic, freeSlots) }];
			});
		});

	return { name: 'follow-up', pausable: true, plan } satisfies Rule;
});
