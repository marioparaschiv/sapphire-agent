import { Effect, Option } from 'effect';
import { Chat, type ThreadRef } from './chat.ts';
import { Herdr } from './herdr.ts';
import { Journal, type ProjectSettings, type Request, type Run, sessionName } from './journal.ts';
import { hasRunInFlight, isInFlight, isStarted, type Observation, tabOf } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { Projects } from './projects.ts';
import { makeTabActions } from './run-actions.ts';

const verbs = { stop: 'stop', send: 'send', 'follow-up': 'follow up on', session: 'change the session of' } as const;

type ProjectRequest = Extract<Request, { readonly _tag: 'project-add' | 'project-edit' | 'project-remove' }>;

const isProjectRequest = (request: Request): request is ProjectRequest =>
	request._tag === 'project-add' || request._tag === 'project-edit' || request._tag === 'project-remove';

// Acts on `ctl.sh stop`, `ctl.sh send`, `sapphire project` (a removed project's thread is deleted with it) and the
// session changes the agent event server recorded, oldest first, and drops follow-up requests that can never be
// claimed. Each request is dropped once acted on, so a crash before that repeats the stop (a no-op once the run ended)
// or types the message again. Not paused: a stop must work while paused.
export const requestsRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const herdr = yield* Herdr;
	const projects = yield* Projects;
	const chat = yield* Chat;
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

	const putProject = (requestId: number, settings: ProjectSettings, thread: ThreadRef | null, said: string) =>
		projects.put({ ...settings, thread }).pipe(Effect.andThen(journal.deleteRequest(requestId)), Effect.andThen(Effect.log(said)));

	// The CLI checked the request; this checks again what may have changed since.
	const applyProject = (observation: Observation, runs: ReadonlyArray<Run>, requestId: number, request: ProjectRequest) =>
		Effect.gen(function* () {
			const team = request._tag === 'project-remove' ? request.team : request.project.team;
			const project = yield* projects.get(team);

			switch (request._tag) {
				case 'project-add':
					return yield* Option.isSome(project)
						? drop(requestId, `project ${team} exists already`)
						: putProject(requestId, request.project, null, `added project ${team} in ${request.project.repo}`);
				case 'project-edit':
					return yield* Option.isNone(project)
						? drop(requestId, `there is no project ${team} to edit`)
						: putProject(requestId, request.project, project.value.thread, `changed project ${team}`);
				case 'project-remove': {
					if (Option.isNone(project)) {
						return yield* drop(requestId, `there is no project ${team} to remove`);
					}

					const resolved = [...observation.teams.values()].find((candidate) => candidate.team.name === team);

					if (resolved !== undefined && hasRunInFlight(runs, resolved.team.id)) {
						return yield* drop(requestId, `project ${team} has a run in flight, so it is not removed`);
					}

					if (project.value.thread !== null) {
						yield* chat.send({ _tag: 'closeThread', thread: project.value.thread });
					}

					yield* projects.remove(team);
					yield* journal.deleteRequest(requestId);
					yield* Effect.log(`removed project ${team}`);
				}
			}
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const work: Array<Work> = [];
			const busy = new Set<string>();

			const requests = yield* journal.listRequests;
			const projectRequests = requests.flatMap(({ id, request }) => (isProjectRequest(request) ? [{ id, request }] : []));

			// In order, as each may build on the one before.
			if (projectRequests.length > 0) {
				work.push({ task: 'projects', apply: Effect.forEach(projectRequests, ({ id, request }) => applyProject(observation, runs, id, request), { discard: true }) });
			}

			for (const { id, request } of requests) {
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
