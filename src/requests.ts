import { Effect, Option } from 'effect';
import { Journal, type Project, type Request, type Run, sessionName } from './journal.ts';
import { acceptsMessages, hasRunInFlight, isInFlight, type Observation } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { Projects } from './projects.ts';
import { makeEndRun, makeInterrupt, makeSend } from './run-actions.ts';

const verbs = { stop: 'stop', send: 'send', 'follow-up': 'follow up on', session: 'change the session of' } as const;

type ProjectRequest = Extract<Request, { readonly _tag: 'project-add' | 'project-edit' | 'project-remove' }>;

const isProjectRequest = (request: Request): request is ProjectRequest =>
	request._tag === 'project-add' || request._tag === 'project-edit' || request._tag === 'project-remove';

// Acts on `ctl.sh stop`, `ctl.sh send` (sent to the run's T3 thread), `sapphire
// project` and the session changes the agent event server recorded, oldest first, and drops follow-up requests that can
// never be claimed. Each request is dropped once acted on, so a crash before that repeats the stop (a no-op once the run
// ended) or sends the message again (T3 drops a send it took already). Not paused: a stop must work while paused.
export const requestsRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const projects = yield* Projects;
	const endRun = yield* makeEndRun;
	const interrupt = yield* makeInterrupt;
	const sendToThread = yield* makeSend;

	const drop = (requestId: number, reason: string) => journal.deleteRequest(requestId).pipe(Effect.andThen(Effect.log(`${reason}; dropped request ${requestId}`)));

	// Interrupts the thread even while the agent works: being stopped is what was asked for.
	const stop = (run: Run, requestId: number) =>
		isInFlight(run)
			? interrupt(run, 'stopped on request', `stop-${requestId}`).pipe(
					Effect.andThen(endRun(run, 'stopped on request')),
					Effect.andThen(journal.deleteRequest(requestId)),
				)
			: drop(requestId, 'no run in flight to stop');

	const send = (run: Run, requestId: number, text: string) =>
		acceptsMessages(run)
			? sendToThread(run, text, { mode: 'auto', clientRequestId: `send-${requestId}` }).pipe(Effect.andThen(journal.deleteRequest(requestId)))
			: drop(requestId, 'no agent to send it to');

	// The run keeps its session's name, which other sessions message it by.
	const changeSession = (run: Run, requestId: number, sessionId: string) =>
		isInFlight(run)
			? journal.putRun({ ...run, session: { id: sessionId, name: run.session?.name ?? sessionName(run.identifier) } }).pipe(Effect.andThen(journal.deleteRequest(requestId)))
			: drop(requestId, 'no run in flight to change the session of');

	const putProject = (requestId: number, project: Project, said: string) =>
		projects.put(project).pipe(Effect.andThen(journal.deleteRequest(requestId)), Effect.andThen(Effect.log(said)));

	// The CLI checked the request; this checks again what may have changed since.
	const applyProject = (observation: Observation, runs: ReadonlyArray<Run>, requestId: number, request: ProjectRequest) =>
		Effect.gen(function* () {
			const team = request._tag === 'project-remove' ? request.team : request.project.team;
			const project = yield* projects.get(team);

			switch (request._tag) {
				case 'project-add':
					return yield* Option.isSome(project)
						? drop(requestId, `project ${team} exists already`)
						: putProject(requestId, request.project, `added project ${team} in ${request.project.repo}`);
				case 'project-edit':
					return yield* Option.isNone(project)
						? drop(requestId, `there is no project ${team} to edit`)
						: putProject(requestId, request.project, `changed project ${team}`);
				case 'project-remove': {
					if (Option.isNone(project)) {
						return yield* drop(requestId, `there is no project ${team} to remove`);
					}

					const resolved = [...observation.teams.values()].find((candidate) => candidate.team.name === team);

					if (resolved !== undefined && hasRunInFlight(runs, resolved.team.id)) {
						return yield* drop(requestId, `project ${team} has a run in flight, so it is not removed`);
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
					request._tag === 'stop' ? stop(run, id) : request._tag === 'send' ? send(run, id, request.text) : changeSession(run, id, request.sessionId);

				work.push({ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply });
			}

			return work;
		});

	return { name: 'requests', pausable: false, plan } satisfies Rule;
});
