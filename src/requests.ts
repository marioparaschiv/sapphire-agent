import { Effect, Option } from 'effect';
import { Herdr } from './herdr.ts';
import { Journal, type Run, sessionName } from './journal.ts';
import { isInFlight, isStarted, type Observation, tabOf } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { makeTabActions } from './run-actions.ts';

const verbs = { stop: 'stop', send: 'send', 'follow-up': 'follow up on', session: 'change the session of' } as const;

// Acts on `ctl.sh stop`, `ctl.sh send` and the session changes the agent event server recorded, oldest first, and
// drops follow-up requests that can never be claimed. Each request is dropped once acted on, so a crash before that
// repeats the stop (a no-op once the run ended) or types the message again. Not paused: a stop must work while paused.
export const requestsRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const herdr = yield* Herdr;
	const { endRun } = yield* makeTabActions;

	const drop = (requestId: number, reason: string) => journal.deleteRequest(requestId).pipe(Effect.andThen(Effect.log(`${reason}; dropped request ${requestId}`)));

	// Closes the tab even while the agent works: being stopped is what was asked for.
	const stop = (observation: Observation, run: Run, requestId: number) =>
		isInFlight(run) ? endRun(observation, run, 'stopped on request').pipe(Effect.andThen(journal.deleteRequest(requestId))) : drop(requestId, 'no run in flight to stop');

	const send = (observation: Observation, run: Run, requestId: number, text: string) =>
		Effect.gen(function* () {
			if (!isInFlight(run) || !isStarted(run) || Option.isNone(tabOf(observation, run))) {
				return yield* drop(requestId, 'no agent to send it to');
			}

			yield* herdr.prompt(run.paneId, text).pipe(
				Effect.andThen(Effect.log(`sent request ${requestId} to ${run.paneId}`)),
				// e.g. the agent sits at a dialog; the request asked once, so it is not tried again.
				Effect.catchTag('Permanent', (error) => Effect.logWarning(`sending request ${requestId} to ${run.paneId} failed: ${error.message}`)),
			);
			yield* journal.deleteRequest(requestId);
		});

	// The run keeps its session's name, which other sessions message it by.
	const changeSession = (run: Run, requestId: number, sessionId: string) =>
		isInFlight(run)
			? journal.putRun({ ...run, session: { id: sessionId, name: run.session?.name ?? sessionName(run.identifier) } }).pipe(Effect.andThen(journal.deleteRequest(requestId)))
			: drop(requestId, 'no run in flight to change the session of');

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const work: Array<Work> = [];
			const busy = new Set<string>();

			for (const { id, request } of yield* journal.listRequests) {
				if (request._tag !== 'stop' && request._tag !== 'send' && request._tag !== 'follow-up' && request._tag !== 'session') {
					continue;
				}

				const run = runs.find((candidate) => candidate.identifier === request.identifier);

				if (!run || (request._tag === 'follow-up' && run.status === 'kept')) {
					work.push({ task: `request ${id}`, apply: drop(id, `${request.identifier} has no run to ${verbs[request._tag]}`) });
					continue;
				}

				if (request._tag === 'follow-up' || busy.has(run.epicId)) {
					continue;
				}

				busy.add(run.epicId);

				const apply =
					request._tag === 'stop' ? stop(observation, run, id) : request._tag === 'send' ? send(observation, run, id, request.text) : changeSession(run, id, request.sessionId);

				work.push({ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply });
			}

			return work;
		});

	return { name: 'requests', pausable: false, plan } satisfies Rule;
});
