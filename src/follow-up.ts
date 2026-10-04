import { Clock, Effect, Option } from 'effect';
import { AppConfig } from './config.ts';
import { claimedRun } from './dispatch.ts';
import { Journal, type Request, type Run } from './journal.ts';
import type { Epic } from './linear.ts';
import { hasRole, isInFlight, type Observation, stuckLabelOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';

type FollowUpRequest = Extract<Request, { readonly _tag: 'follow-up' }>;

// Claims a follow-up run for each follow-up request (`ctl.sh follow-up`), oldest first, once the epic's last run ended
// and while the epic is in To Review, in a resolved team, without the stuck label, and maxInFlight allows. One claim per
// epic per tick: a second request for it waits until that follow-up ended too. The claim replaces the ended run and
// drops the request in one transaction; the start rule takes it from there (pull, /follow-up).
export const followUpRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;

	const claim = (run: Run, epic: Epic, requestId: number, { threadIds, instruction }: FollowUpRequest) =>
		Effect.gen(function* () {
			yield* journal.claimFollowUp(claimedRun(epic, run.repo, yield* Clock.currentTimeMillis, { _tag: 'follow-up', threadIds, instruction }), requestId);
			yield* Effect.log(`claimed a follow-up for ${threadIds.length} review threads${instruction === null ? '' : ' and an instruction'}`);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const requests = yield* journal.listRequests;
			let free = config.maxInFlight - runs.filter(isInFlight).length;
			const work: Array<EpicWork> = [];

			for (const { id, request } of requests) {
				if (free <= 0) {
					break;
				}

				if (request._tag !== 'follow-up') {
					continue;
				}

				const run = runs.find((candidate) => candidate.identifier === request.identifier);
				const epic = Option.fromUndefinedOr(run && observation.epics.get(run.epicId));

				if (
					!run ||
					Option.isNone(epic) ||
					run.status !== 'ended' ||
					work.some((claimed) => claimed.epicId === run.epicId) ||
					!observation.teams.has(run.teamId) ||
					!hasRole(observation, epic.value, ['toReview']) ||
					Option.isSome(stuckLabelOf(config, epic.value))
				) {
					continue;
				}

				free -= 1;
				work.push({ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply: claim(run, epic.value, id, request) });
			}

			return work;
		});

	return { name: 'follow-up', pausable: true, plan } satisfies Rule;
});
