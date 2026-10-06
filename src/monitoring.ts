import { createHash } from 'node:crypto';
import { Clock, Effect, Option } from 'effect';
import { Chat } from './chat.ts';
import { ClaudeTranscript } from './claude-transcript.ts';
import { Comments, type FlaggedRun, shownTail } from './comments.ts';
import { AppConfig } from './config.ts';
import { Herdr } from './herdr.ts';
import { type AgentStatus, Journal, type Run, type Topic } from './journal.ts';
import type { Epic } from './linear.ts';
import { activeRoles, hasRole, isStarted, type Observation, observedAgentStatus, type StartedRun, tabOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Prompts } from './prompts.ts';
import { makeFlag, makeNudge, makeTabActions } from './run-actions.ts';

export const quietStatuses: ReadonlyArray<AgentStatus> = ['idle', 'done', 'blocked'];

// Claude's spinner glyph, its elapsed timer and the status line's counters tick even while a turn hangs, so they are
// not progress.
const withoutTickers = (tail: string) => tail.replace(/[\d·✢✳✶✻✽]/g, '');

export const tailHash = (tail: string) => createHash('sha256').update(withoutTickers(tail)).digest('hex');

const watchedStatuses: ReadonlyArray<Run['status']> = ['running', 'awaitingInput', 'stale'];

// What runs and commands record of their agent between ticks.
export type AgentWatch = Pick<Run, 'agentStatus' | 'agentStatusSince' | 'tailHash' | 'nudgedAt'>;

// What the agent did since the last tick, and whether that was progress. `since` restarts on every change, except
// between quiet statuses (idle to done keeps the quiet timer) and while status and tail stay the same. Any change
// clears the nudge.
export const trackAgent = <W extends AgentWatch>(watch: W, status: AgentStatus, hash: string, now: number): { readonly tracked: W; readonly progressed: boolean } => {
	const previous = watch.agentStatus;
	const stillQuiet = previous !== null && quietStatuses.includes(previous) && quietStatuses.includes(status);
	const unchanged = previous === status && watch.tailHash === hash;
	const progressed = !stillQuiet && !unchanged;

	return {
		tracked: {
			...watch,
			agentStatus: status,
			agentStatusSince: progressed || watch.agentStatusSince === null ? now : watch.agentStatusSince,
			tailHash: hash,
			nudgedAt: progressed ? null : watch.nudgedAt,
		},
		progressed,
	};
};

export const isSameWatch = (a: AgentWatch, b: AgentWatch) =>
	a.agentStatus === b.agentStatus && a.agentStatusSince === b.agentStatusSince && a.tailHash === b.tailHash && a.nudgedAt === b.nudgedAt;

// See trackAgent. Progress also ends a stale episode, and working again ends an awaitingInput one.
export const track = <R extends Run>(run: R, status: AgentStatus, hash: string, now: number): R => {
	const { tracked, progressed } = trackAgent(run, status, hash, now);
	const resumed = (run.status === 'awaitingInput' && status === 'working') || (run.status === 'stale' && progressed);

	return { ...tracked, status: resumed ? 'running' : run.status };
};

const sameRun = (a: Run, b: Run) => a.status === b.status && isSameWatch(a, b);

// Watches started runs in herdr. Every tick reads herdr afresh, so an event that never arrived changes nothing: the
// poll always wins. Flags, once each: awaitingInput (quiet too long without a result file), stale (working with an
// unchanged pane even after a nudge), error (agent exited or vanished; its tab is then closed) and the wall-clock cap.
// A run that asked its reply-to session by message is not flagged while it waits for the reply; after staleAfterSeconds
// its question is asked in its epic's chat thread instead. A run without one asks there at once. The user's messages in
// the thread go to the agent. An epic without a thread is flagged instead, to be answered in the agent's tab.
export const monitoringRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const chat = yield* Chat;
	const herdr = yield* Herdr;
	const comments = yield* Comments;
	const prompts = yield* Prompts;
	const transcript = yield* ClaudeTranscript;
	const flag = yield* makeFlag;
	const { closeRunTab } = yield* makeTabActions;
	const nudge = yield* makeNudge;

	const flaggedRun = (observation: Observation, run: StartedRun, epic: Epic, tail: string, now: number): FlaggedRun => ({
		identifier: run.identifier,
		claimedAt: run.claimedAt,
		tabLabel: Option.match(tabOf(observation, run), { onNone: () => prompts.tabLabel(epic), onSome: (tab) => tab.label }),
		tabId: run.tabId,
		paneId: run.paneId,
		worktreePath: run.worktreePath,
		branch: run.branch,
		agentStatus: run.agentStatus ?? 'unknown',
		agentStatusSince: run.agentStatusSince ?? now,
		tail,
		now,
	});

	// The question the agent sent its reply-to session and ended its turn on, while no reply came.
	const pendingMessage = (run: StartedRun) =>
		run.replyTo === null || run.session === null ? Effect.succeedNone : transcript.pendingMessage({ id: run.session.id, cwd: run.worktreePath }, run.replyTo);

	const monitor = (observation: Observation, watched: StartedRun, epic: Epic, topic: Option.Option<Topic>) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const status = observedAgentStatus(observation, watched);
			const tail = status === 'vanished' ? '' : Option.getOrElse(yield* herdr.readTail(watched.paneId), () => '');
			let run = track(watched, status, tailHash(tail), now);

			if (!sameRun(watched, run)) {
				yield* journal.putRun(run);

				if (run.status === 'running' && watched.status !== 'running') {
					yield* Effect.log('agent is working again');
				}
			}

			if (now - run.claimedAt >= config.maxRunSeconds * 1000) {
				yield* flag(observation, run, comments.overCap({ identifier: run.identifier, claimedAt: run.claimedAt, status: run.status, tail, now }));
			}

			// The results rule owns a run with a result file, or whose epic moved on.
			if (run.result !== null || !hasRole(observation, epic, activeRoles(run))) {
				return;
			}

			const since = run.agentStatusSince ?? now;

			if (status === 'exited' || status === 'vanished') {
				yield* Effect.log(`agent ${status} without a result file; flagging it as error`);
				yield* flag(observation, run, comments.agentStopped(flaggedRun(observation, run, epic, tail, now)));
				yield* closeRunTab(observation, run);
				yield* journal.putRun({ ...run, status: 'error' });

				return;
			}

			if (run.status === 'running' && quietStatuses.includes(status) && now - since >= Math.min(config.awaitingInputAfterSeconds, config.staleAfterSeconds) * 1000) {
				const message = yield* pendingMessage(run);

				if (now - since < (Option.isSome(message) ? config.staleAfterSeconds : config.awaitingInputAfterSeconds) * 1000) {
					return;
				}

				// The question is posted before the status records it, and the chat shows it once, so a crash in between is safe.
				if (Option.isSome(topic)) {
					yield* Effect.log(
						Option.isSome(message)
							? `no reply to the agent's message for ${config.staleAfterSeconds} s; asking in its chat thread`
							: `agent ${status} without a result file; asking in its chat thread`,
					);
					yield* chat.send({ _tag: 'question', thread: topic.value.thread, text: Option.getOrElse(message, () => shownTail(tail)), askedAt: since });
					yield* journal.putRun({ ...run, status: 'awaitingInput' });

					return;
				}

				yield* Effect.log(`agent ${status} without a result file and its epic has no chat thread; flagging it as awaitingInput`);
				yield* flag(
					observation,
					run,
					Option.match(message, {
						onNone: () => comments.awaitingInput(flaggedRun(observation, run, epic, tail, now)),
						onSome: (text) => comments.messageQuestion({ identifier: run.identifier, claimedAt: run.claimedAt, agentStatusSince: since, message: text }),
					}),
				);

				yield* journal.putRun({ ...run, status: 'awaitingInput' });

				return;
			}

			if (run.status === 'running' && status === 'working') {
				if (run.nudgedAt === null) {
					if (now - since >= config.staleAfterSeconds * 1000) {
						yield* Effect.log(`no new output for ${config.staleAfterSeconds} s; nudging the agent`);
						run = { ...run, nudgedAt: now };
						yield* journal.putRun(run);
						yield* nudge(run.paneId);
					}

					return;
				}

				if (now - run.nudgedAt >= config.nudgeGraceSeconds * 1000) {
					yield* Effect.log('still no new output after the nudge; flagging it as stale');
					yield* flag(observation, run, comments.stale({ ...flaggedRun(observation, run, epic, tail, now), nudgedAt: run.nudgedAt }));
					yield* journal.putRun({ ...run, status: 'stale' });
				}

				return;
			}
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter(
				(run): run is StartedRun => watchedStatuses.includes(run.status) && isStarted(run) && observation.teams.has(run.teamId) && observation.epics.has(run.epicId),
			);
			const topics = yield* journal.listTopics;

			return runs.flatMap((run): Array<EpicWork> => {
				const epic = observation.epics.get(run.epicId);

				if (!epic) {
					return [];
				}

				return [{ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply: monitor(observation, run, epic, Option.fromUndefinedOr(topics.find((topic) => topic.epicId === run.epicId))) }];
			});
		});

	return { name: 'monitoring', pausable: false, plan } satisfies Rule;
});
