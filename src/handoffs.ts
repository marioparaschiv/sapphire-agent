import { join } from 'node:path';
import { Clock, Effect, FileSystem, Option } from 'effect';
import type { AgentEvent, AgentName } from './agent-event.ts';
import { fileSystemFailure } from './call-policy.ts';
import { ClaudeTranscript } from './claude-transcript.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { handoffPath } from './directories.ts';
import { type Handoff, Journal, type Run } from './journal.ts';
import { isAgentWorking, isInFlight, isThreaded, type Observation, type ThreadedRun } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { Prompts, threadOrdinal } from './prompts.ts';
import { Reconciler } from './reconciler.ts';
import { makeSend, makeSettle } from './run-actions.ts';
import { T3 } from './t3.ts';
import { T3Projects } from './t3-projects.ts';

// A subagent that goes on this far past the threshold after it was told to hand off gets a notice.
const subagentOverRatio = 1.2;

// A tool call or a turn's end, which checks the context of the agent that made it.
type ContextEvent = Extract<AgentEvent, { readonly _tag: 'ToolUsed' | 'TurnEnded' }>;

const handoffSkillOf = (claudeConfigDirectory: string) => join(claudeConfigDirectory, 'skills', 'handoff', 'SKILL.md');

// Checks a run's context after a tool call or the end of a turn: the context the agent reported with the event, else
// its transcript's. The run's own session at handoffAtTokens records a `handoff` request, which the handoff rule acts
// on. A subagent at handoffAtTokens is told once, by what its hook prints, to write a handoff doc and end with
// `HANDOFF <path>`; one still going past 1.2 times that gets a notice. Returns what the hook prints, if anything.
export const makeContextCheck = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const transcript = yield* ClaudeTranscript;
	const comments = yield* Comments;
	const prompts = yield* Prompts;
	const reconciler = yield* Reconciler;
	const handoffSkill = handoffSkillOf(config.env.claudeConfigDirectory);

	const contextTokens = (run: ThreadedRun, event: ContextEvent, agentId: string | null) =>
		event.contextTokens === undefined ? transcript.contextTokens({ id: event.sessionId, cwd: run.worktreePath }, agentId) : Effect.succeed(Option.fromNullOr(event.contextTokens));

	const orchestrator = (run: ThreadedRun, agent: AgentName, event: ContextEvent) =>
		Effect.gen(function* () {
			const { sessionId } = event;

			if (run.session?.id !== sessionId || run.handoff?.sessionId === sessionId) {
				return;
			}

			const tokens = yield* contextTokens(run, event, null);

			if (Option.isNone(tokens) || tokens.value < config.handoffAtTokens) {
				return;
			}

			if ((yield* journal.listRequests).some(({ request }) => request._tag === 'handoff' && request.sessionId === sessionId)) {
				return;
			}

			yield* journal.addRequest({ _tag: 'handoff', identifier: run.identifier, sessionId, agent });
			yield* Effect.log(`${run.identifier}'s context reached ${tokens.value} tokens; it hands off`);
			yield* reconciler.wake;
		});

	const subagent = (run: ThreadedRun, event: ContextEvent, agentId: string) =>
		Effect.gen(function* () {
			const tokens = Option.getOrElse(yield* contextTokens(run, event, agentId), () => 0);

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

	return (run: ThreadedRun, agent: AgentName, event: ContextEvent) =>
		event._tag === 'ToolUsed' && event.agentId !== null ? subagent(run, event, event.agentId) : orchestrator(run, agent, event).pipe(Effect.as(Option.none<string>()));
});

// Hands a run's agent over to a fresh thread once its context filled up, as a thread cannot be cleared: sends the
// thread the handoff skill, as its agent invokes it, with the doc's path, and once the doc exists and the thread stopped, settles it and launches the
// run's next thread on the same worktree and branch (`<ID> (2) ...`, counting up) to read the doc; the run moves to that
// thread. Each step is recorded on the run before it is sent, so a crash or restart never sends one twice; a thread
// launched just before a crash is found by its title. A doc still missing startTimeoutSeconds after the turn ended gets
// a notice, and nothing goes on. Not paused: it only keeps runs in flight going.
export const handoffRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const t3 = yield* T3;
	const t3Projects = yield* T3Projects;
	const comments = yield* Comments;
	const prompts = yield* Prompts;
	const fs = yield* FileSystem.FileSystem;
	const send = yield* makeSend;
	const settle = yield* makeSettle;
	const handoffSkill = handoffSkillOf(config.env.claudeConfigDirectory);

	// The request goes once the send landed, so a crash or a failed send before that sends it again on a later tick,
	// under the same key.
	const request = (run: ThreadedRun, requestId: number, sessionId: string, agent: AgentName) =>
		Effect.gen(function* () {
			if (run.session?.id !== sessionId || (run.handoff?.sessionId === sessionId && run.handoff.step === 'resumed')) {
				yield* journal.deleteRequest(requestId);
				yield* Effect.log(`session ${sessionId} is no longer the run's or handed off already; dropped request ${requestId}`);

				return;
			}

			const requested: ThreadedRun = { ...run, handoff: { sessionId, step: 'requested' } };

			if (run.handoff?.sessionId !== sessionId) {
				yield* journal.putRun(requested);
			}

			yield* send(requested, prompts.handoff({ agent, path: handoffPath(run.identifier, sessionId), skill: handoffSkill }), { mode: 'auto', clientRequestId: `handoff-${sessionId}` });
			yield* journal.deleteRequest(requestId);
		});

	// Once its turn ended without the doc for startTimeoutSeconds.
	const noticeMissing = (run: Run, handoff: Handoff, path: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const notice = comments.handoffMissing({ identifier: run.identifier, sessionId: handoff.sessionId, path });

			if (now - (run.agentStatusSince ?? now) >= config.startTimeoutSeconds * 1000 && (yield* journal.addNotice(notice))) {
				yield* Effect.log(`no handoff doc at ${path}; the thread stays`);
			}
		});

	const docExists = (path: string) => fs.exists(path).pipe(Effect.mapError(fileSystemFailure));

	// The thread launched for this handoff before a crash, by its title.
	const launchedBefore = (projectId: string, run: ThreadedRun, ordinal: number) =>
		t3.listThreads({ projectId, titleContains: `${run.identifier} (${ordinal})`, includeSubagents: false }).pipe(
			Effect.map((threads) => Option.fromUndefinedOr(threads.find((thread) => thread.title.startsWith(`${run.identifier} (${ordinal}) `)))),
		);

	const advance = (observation: Observation, run: ThreadedRun, handoff: Handoff) =>
		Effect.gen(function* () {
			const path = handoffPath(run.identifier, handoff.sessionId);
			const thread = observation.threads.get(run.threadId);
			const epic = observation.epics.get(run.epicId);

			if (handoff.step !== 'requested' || thread === undefined || epic === undefined || isAgentWorking(observation, run)) {
				return;
			}

			if (!(yield* docExists(path))) {
				return yield* noticeMissing(run, handoff, path);
			}

			const ordinal = threadOrdinal(run.identifier, thread.title ?? '') + 1;

			yield* settle(run.threadId);

			const projectId = yield* t3Projects.projectFor(run.repo);
			const found = yield* launchedBefore(projectId, run, ordinal);
			const next = yield* Option.match(found, {
				onSome: (summary) => Effect.log(`adopting T3 thread ${summary.threadId}`).pipe(Effect.as({ threadId: summary.threadId, runId: summary.latestRunId })),
				onNone: () =>
					t3.launchThread({
						projectId,
						title: prompts.threadTitle(epic, ordinal),
						message: prompts.resumeHandoff(path),
						workspaceStrategy: { type: 'existing_worktree', worktreePath: run.worktreePath, branch: run.branch },
						runtimeMode: 'full-access',
					}),
			});

			yield* journal.putRun({ ...run, threadId: next.threadId, threadRunId: next.runId, handoff: { ...handoff, step: 'resumed' } });
			yield* Effect.log(`the run goes on in T3 thread ${next.threadId}`);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter((run): run is ThreadedRun => isInFlight(run) && isThreaded(run));
			const requests = (yield* journal.listRequests).flatMap(({ id, request }) => (request._tag === 'handoff' ? [{ id, ...request }] : []));

			const dropped = requests
				.filter((found) => !runs.some((run) => run.identifier === found.identifier))
				.map((found): Work => ({ task: `request ${found.id}`, apply: journal.deleteRequest(found.id).pipe(Effect.andThen(Effect.log(`${found.identifier} has no run to hand off; dropped request ${found.id}`))) }));

			const moved = runs.flatMap((run): Array<Work> => {
				const pending = requests.find((found) => found.identifier === run.identifier);
				const work = { epicId: run.epicId, identifier: run.identifier, teamId: run.teamId };

				if (pending !== undefined) {
					return [{ ...work, apply: request(run, pending.id, pending.sessionId, pending.agent) }];
				}

				if (run.handoff === null || run.handoff.step === 'resumed') {
					return [];
				}

				return [{ ...work, apply: advance(observation, run, run.handoff) }];
			});

			return [...dropped, ...moved];
		});

	return { name: 'handoff', pausable: false, plan } satisfies Rule;
});
