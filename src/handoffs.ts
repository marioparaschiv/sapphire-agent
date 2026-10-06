import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clock, Effect, FileSystem, Option } from 'effect';
import { fileSystemFailure } from './call-policy.ts';
import { ClaudeTranscript } from './claude-transcript.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { Herdr } from './herdr.ts';
import { type AgentStatus, type Handoff, Journal } from './journal.ts';
import { isInFlight, isStarted, type Observation, observedAgentStatus, type StartedRun } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { Prompts } from './prompts.ts';
import { Reconciler } from './reconciler.ts';

// The doc a run's session, or one of its subagents, hands its work over in.
export const handoffPath = (identifier: string, sessionOrAgentId: string) => join(tmpdir(), `sapphire-agent-handoff-${identifier}-${sessionOrAgentId}.md`);

// A subagent that goes on this far past the threshold after it was told to hand off gets a notice.
const subagentOverRatio = 1.2;

const turnEndedStatuses: ReadonlyArray<AgentStatus> = ['idle', 'done'];

// Checks a run's context after a tool call or the end of a turn. The run's own session at handoffAtTokens records a
// `handoff` request, which the handoff rule acts on. A subagent at handoffAtTokens is told once, by what its hook
// prints, to write a handoff doc and end with `HANDOFF <path>`; one still going past 1.2 times that gets a notice.
// Returns what the hook prints, if anything.
export const makeContextCheck = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const transcript = yield* ClaudeTranscript;
	const comments = yield* Comments;
	const prompts = yield* Prompts;
	const reconciler = yield* Reconciler;
	const handoffSkill = join(config.env.claudeConfigDirectory, 'skills', 'handoff', 'SKILL.md');

	const orchestrator = (run: StartedRun, sessionId: string) =>
		Effect.gen(function* () {
			if (run.session?.id !== sessionId || run.handoff?.sessionId === sessionId) {
				return;
			}

			const tokens = yield* transcript.contextTokens({ id: sessionId, cwd: run.worktreePath }, null);

			if (Option.isNone(tokens) || tokens.value < config.handoffAtTokens) {
				return;
			}

			if ((yield* journal.listRequests).some(({ request }) => request._tag === 'handoff' && request.sessionId === sessionId)) {
				return;
			}

			yield* journal.addRequest({ _tag: 'handoff', identifier: run.identifier, sessionId });
			yield* Effect.log(`${run.identifier}'s context reached ${tokens.value} tokens; it hands off`);
			yield* reconciler.wake;
		});

	const subagent = (run: StartedRun, sessionId: string, agentId: string) =>
		Effect.gen(function* () {
			const tokens = Option.getOrElse(yield* transcript.contextTokens({ id: sessionId, cwd: run.worktreePath }, agentId), () => 0);

			if (tokens < config.handoffAtTokens) {
				return Option.none();
			}

			if (yield* journal.addSubagentHandoff({ agentId, identifier: run.identifier })) {
				yield* Effect.log(`${run.identifier}'s subagent ${agentId} reached ${tokens} tokens; told it to hand off`);

				return Option.some(prompts.subagentHandoff({ path: handoffPath(run.identifier, agentId), skill: handoffSkill }));
			}

			const notice = comments.subagentOverContext({ identifier: run.identifier, agentId, tokens });

			if (tokens >= config.handoffAtTokens * subagentOverRatio && (yield* journal.addNotice(notice))) {
				yield* Effect.log(`${run.identifier}'s subagent ${agentId} did not hand off at ${tokens} tokens`);
				yield* reconciler.wake;
			}

			return Option.none();
		});

	return (run: StartedRun, sessionId: string, agentId: string | null) =>
		agentId === null ? orchestrator(run, sessionId).pipe(Effect.as(Option.none<string>())) : subagent(run, sessionId, agentId);
});

// Hands a run's session over to a fresh one: types `/handoff` with the doc's path, `/clear` once the doc exists and
// the turn ended, then tells the new session to read the doc. Each step is recorded on the run before it is typed, so
// a crash or restart never types one twice. A doc still missing startTimeoutSeconds after the turn ended gets a
// notice, and the session is not cleared. Not paused: it only keeps runs in flight going.
export const handoffRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const herdr = yield* Herdr;
	const comments = yield* Comments;
	const prompts = yield* Prompts;
	const fs = yield* FileSystem.FileSystem;

	// e.g. the agent sits at a dialog; the notice for a missing doc tells the user.
	const typeInto = (run: StartedRun, text: string) =>
		herdr.prompt(run.paneId, text).pipe(
			Effect.andThen(Effect.log(`typed "${text}" into ${run.paneId}`)),
			Effect.catchTag('Permanent', (error) => Effect.logWarning(`typing "${text}" into ${run.paneId} failed: ${error.message}`)),
		);

	const request = (run: StartedRun, requestId: number, sessionId: string) =>
		Effect.gen(function* () {
			if (run.session?.id !== sessionId || run.handoff?.sessionId === sessionId) {
				yield* journal.deleteRequest(requestId);
				yield* Effect.log(`session ${sessionId} is no longer the run's or hands off already; dropped request ${requestId}`);

				return;
			}

			yield* journal.putRun({ ...run, handoff: { sessionId, step: 'requested' } });
			yield* journal.deleteRequest(requestId);
			yield* typeInto(run, prompts.handoff(handoffPath(run.identifier, sessionId)));
		});

	const advance = (observation: Observation, run: StartedRun, handoff: Handoff) =>
		Effect.gen(function* () {
			const path = handoffPath(run.identifier, handoff.sessionId);

			if (handoff.step === 'cleared' && run.session !== null && run.session.id !== handoff.sessionId) {
				yield* journal.putRun({ ...run, handoff: { ...handoff, step: 'resumed' } });
				yield* typeInto(run, prompts.resumeHandoff(path));

				return;
			}

			if (handoff.step !== 'requested' || !turnEndedStatuses.includes(observedAgentStatus(observation, run))) {
				return;
			}

			if (yield* fs.exists(path).pipe(Effect.mapError(fileSystemFailure))) {
				yield* journal.putRun({ ...run, handoff: { ...handoff, step: 'cleared' } });
				yield* typeInto(run, '/clear');

				return;
			}

			const now = yield* Clock.currentTimeMillis;
			const notice = comments.handoffMissing({ identifier: run.identifier, sessionId: handoff.sessionId, path });

			if (now - (run.agentStatusSince ?? now) >= config.startTimeoutSeconds * 1000 && (yield* journal.addNotice(notice))) {
				yield* Effect.log(`no handoff doc at ${path}; the session stays`);
			}
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter((run): run is StartedRun => isInFlight(run) && isStarted(run));
			const requests = (yield* journal.listRequests).flatMap(({ id, request }) => (request._tag === 'handoff' ? [{ id, ...request }] : []));

			const dropped = requests
				.filter((found) => !runs.some((run) => run.identifier === found.identifier))
				.map((found): Work => ({ task: `request ${found.id}`, apply: journal.deleteRequest(found.id).pipe(Effect.andThen(Effect.log(`${found.identifier} has no run to hand off; dropped request ${found.id}`))) }));

			const moved = runs.flatMap((run): Array<Work> => {
				const pending = requests.find((found) => found.identifier === run.identifier);
				const work = { epicId: run.epicId, identifier: run.identifier, teamId: run.teamId };

				if (pending !== undefined) {
					return [{ ...work, apply: request(run, pending.id, pending.sessionId) }];
				}

				return run.handoff === null || run.handoff.step === 'resumed' ? [] : [{ ...work, apply: advance(observation, run, run.handoff) }];
			});

			return [...dropped, ...moved];
		});

	return { name: 'handoff', pausable: false, plan } satisfies Rule;
});
