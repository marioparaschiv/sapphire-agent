import { Clock, Effect, Option } from 'effect';
import { AgentActivity } from './agent-activity.ts';
import { Comments, type FlaggedThread } from './comments.ts';
import { AppConfig } from './config.ts';
import { type AgentStatus, Journal, type Run } from './journal.ts';
import type { Epic } from './linear.ts';
import { activeRoles, hasRole, isAgentWorking, isThreaded, type ObservedThread, type Observation, type ThreadedRun } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Pushover, sendOrLog } from './pushover.ts';
import { makeFlag, makeSend } from './run-actions.ts';

const watchedStatuses: ReadonlyArray<Run['status']> = ['running', 'stale'];

const sameRun = (a: Run, b: Run) => a.status === b.status && a.agentStatus === b.agentStatus && a.agentStatusSince === b.agentStatusSince && a.nudgedAt === b.nudgedAt;

// Watches runs by their thread as the observation read it: its last progress is the newest change of the thread, its
// timeline and its subagents' threads, or the newest hook event of its agent or its subagents (`AgentActivity`), so a
// long-running subagent keeps its run going. A run without progress for staleAfterSeconds gets `continue` sent to its
// thread with mode restart, once; still nothing the agent did itself nudgeGraceSeconds later, the epic is flagged stale
// and Pushover is told, and what the agent does next ends the episode. A thread waiting on questions or approvals is
// not stalled: Pushover is told once per wait. Past maxRunSeconds the epic is flagged once.
export const monitoringRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const comments = yield* Comments;
	const flag = yield* makeFlag;
	const send = yield* makeSend;
	const pushover = yield* Pushover;
	const activity = yield* AgentActivity;

	const flaggedThread = (run: ThreadedRun, thread: ObservedThread, agentActiveAt: number, now: number): FlaggedThread => ({
		identifier: run.identifier,
		claimedAt: run.claimedAt,
		threadTitle: thread.title ?? run.identifier,
		threadId: run.threadId,
		worktreePath: run.worktreePath,
		branch: run.branch,
		agentStatusSince: agentActiveAt,
		now,
	});

	// `continue`, restarting the thread's turn. The nudge is recorded first, and keyed by when it was, so sending it again
	// until the grace period is over makes one lost to a crash or a failure land, while T3 drops a repeat.
	const nudgeThread = (run: ThreadedRun, nudgedAt: number) => send(run, 'continue', { mode: 'restart', clientRequestId: `nudge-${run.claimedAt}-${nudgedAt}` });

	const monitorThread = (observation: Observation, watched: ThreadedRun, epic: Epic) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const thread = observation.threads.get(watched.threadId);

			if (now - watched.claimedAt >= config.maxRunSeconds * 1000) {
				yield* flag(observation, watched, comments.overCap({ identifier: watched.identifier, claimedAt: watched.claimedAt, status: watched.status, now }));
			}

			// T3 could not be asked, or no longer has the thread: there is nothing to judge progress by.
			if (thread === undefined || thread.lastProgressAt === null || thread.lastAgentActivityAt === null) {
				return;
			}

			// The newest hook event of the run's agent or its subagents, which T3 may not show. Before the first one since a
			// restart, the restart, so the stall timer starts afresh; it is no progress after a nudge, though.
			const hookedAt = yield* activity.lastAt(watched.epicId);
			const lastAgentActivityAt = Math.max(thread.lastAgentActivityAt, Option.getOrElse(hookedAt, () => 0));
			const lastProgressAt = Math.max(thread.lastProgressAt, Option.getOrElse(hookedAt, () => activity.startedAt));
			const status: AgentStatus = thread.pendingRequests > 0 ? 'blocked' : isAgentWorking(observation, watched) ? 'working' : 'idle';
			const progressed = watched.nudgedAt !== null && lastAgentActivityAt > watched.nudgedAt;
			const resumed = watched.status === 'stale' && progressed;
			let run: ThreadedRun = {
				...watched,
				status: resumed ? 'running' : watched.status,
				agentStatus: status,
				agentStatusSince: lastProgressAt,
				nudgedAt: progressed ? null : watched.nudgedAt,
			};

			if (!sameRun(watched, run)) {
				yield* journal.putRun(run);

				if (resumed) {
					yield* Effect.log('agent is working again');
				}
			}

			// The results rule owns a run with a result file, or whose epic moved on.
			if (run.result !== null || !hasRole(observation, epic, activeRoles(run))) {
				return;
			}

			const quietFor = now - lastProgressAt;
			const title = thread.title ?? run.identifier;

			if (status === 'blocked') {
				if (watched.agentStatus !== 'blocked') {
					yield* Effect.log(`T3 thread ${run.threadId} waits for the user`);
				}

				return;
			}

			if (run.status !== 'running') {
				return;
			}

			if (run.nudgedAt === null) {
				if (quietFor >= config.staleAfterSeconds * 1000) {
					yield* Effect.log(`no progress in T3 thread ${run.threadId} for ${config.staleAfterSeconds} s; nudging the agent`);
					run = { ...run, nudgedAt: now };
					yield* journal.putRun(run);
					yield* nudgeThread(run, now);
				}

				return;
			}

			// A restart since the nudge gives the agent a full grace period, as its hook events in between went unseen.
			if (now - Math.max(run.nudgedAt, activity.startedAt) < config.nudgeGraceSeconds * 1000) {
				return yield* nudgeThread(run, run.nudgedAt);
			}

			// The nudge itself moved the thread; the agent did nothing since this.
			const agentActiveAt = Math.max(lastAgentActivityAt, run.startedAt ?? run.claimedAt);

			yield* Effect.log('still no progress after the nudge; flagging it as stale');
			yield* flag(observation, run, comments.threadStale({ ...flaggedThread(run, thread, agentActiveAt, now), nudgedAt: run.nudgedAt }));
			yield* journal.putRun({ ...run, status: 'stale' });
			yield* sendOrLog(pushover, {
				title: `${run.identifier} looks stuck`,
				message: `No progress in T3 thread "${title}" for ${Math.round((now - agentActiveAt) / 60_000)} min, even after a nudge. The epic is flagged.`,
				url: epic.url,
				priority: 'normal',
			});
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter((run) => watchedStatuses.includes(run.status) && observation.teams.has(run.teamId));

			return runs.flatMap((run): Array<EpicWork> => {
				const epic = observation.epics.get(run.epicId);
				const work = { epicId: run.epicId, identifier: run.identifier, teamId: run.teamId };

				return epic && isThreaded(run) ? [{ ...work, apply: monitorThread(observation, run, epic) }] : [];
			});
		});

	return { name: 'monitoring', pausable: false, plan } satisfies Rule;
});
