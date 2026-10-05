import { createHash } from 'node:crypto';
import { Clock, Effect, Option } from 'effect';
import { ClaudeTranscript } from './claude-transcript.ts';
import { Comments, type FlaggedRun } from './comments.ts';
import { AppConfig } from './config.ts';
import { Herdr } from './herdr.ts';
import { type AgentStatus, Journal, type Run } from './journal.ts';
import { type Epic, Linear, type Reply } from './linear.ts';
import { parseMarker } from './markers.ts';
import { activeRoles, hasRole, isStarted, type Observation, observedAgentStatus, type StartedRun, tabOf } from './observation.ts';
import type { EpicWork, Rule } from './planner.ts';
import { Prompts } from './prompts.ts';
import { makeFlag, makeNudge, makeTabActions } from './run-actions.ts';

export const quietStatuses: ReadonlyArray<AgentStatus> = ['idle', 'done', 'blocked'];

// Marks a reply to a question as typed into the pane.
export const deliveredEmoji = 'white_check_mark';

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

	return { ...tracked, status: resumed ? 'running' : run.status, questionCommentId: resumed ? null : run.questionCommentId };
};

const sameRun = (a: Run, b: Run) => a.status === b.status && isSameWatch(a, b) && a.questionCommentId === b.questionCommentId;

// Watches started runs in herdr. Every tick reads herdr afresh, so an event that never arrived changes nothing: the
// poll always wins. Flags, once each: awaitingInput (quiet too long without a result file), stale (working with an
// unchanged pane even after a nudge), error (agent exited or vanished; its tab is then closed) and the wall-clock cap.
// A run that asked its reply-to session by message is not flagged while it waits for the reply; after staleAfterSeconds
// its question is asked on Linear instead. While awaitingInput, the user's replies to the question are typed into the pane.
export const monitoringRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const herdr = yield* Herdr;
	const linear = yield* Linear;
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

	// The reply is typed, then recorded, then marked: a recorded reply is never typed again, and one without the emoji
	// gets it next tick. A crash between typing and recording types it again after the restart, which beats losing it.
	// A refused reply (e.g. the agent sits at a dialog) gets a notice under the question, whose marker also keeps it
	// from being typed later.
	const deliverReplies = (initial: StartedRun, question: string, replies: ReadonlyArray<Reply>) =>
		Effect.gen(function* () {
			let run = initial;
			const notices = replies.flatMap((reply) => Option.toArray(parseMarker(reply.body)));
			const refused = new Set(notices.filter((marker) => marker.purpose === 'replyFailed').map((marker) => marker.key));
			const fromUser = replies
				.filter((reply) => Option.isNone(parseMarker(reply.body)) && !/^\*\*(sapphire-agent|herdr-linear)/.test(reply.body))
				.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

			for (const reply of fromUser) {
				if (reply.reactions.some((reaction) => reaction.emoji === deliveredEmoji) || refused.has(reply.id)) {
					continue;
				}

				if (run.deliveredReplyIds.includes(reply.id)) {
					yield* linear.react(reply.id, deliveredEmoji);
					continue;
				}

				const typed = yield* herdr.prompt(run.paneId, reply.body).pipe(
					Effect.as(true),
					Effect.catchTag('Permanent', (error) =>
						Effect.logWarning(`typing reply ${reply.id} failed: ${error.message}`).pipe(
							Effect.andThen(linear.comment(run.epicId, comments.replyFailed({ identifier: run.identifier, replyCommentId: reply.id, error: error.message }), question)),
							Effect.as(false),
						),
					),
				);

				if (typed) {
					run = { ...run, deliveredReplyIds: [...run.deliveredReplyIds, reply.id] };
					yield* journal.putRun(run);
					yield* linear.react(reply.id, deliveredEmoji);
					yield* Effect.log(`typed reply ${reply.id} into ${run.paneId}`);
				}
			}
		});

	// The question the agent sent its reply-to session and ended its turn on, while no reply came.
	const pendingMessage = (run: StartedRun) =>
		run.replyTo === null || run.session === null ? Effect.succeedNone : transcript.pendingMessage({ id: run.session.id, cwd: run.worktreePath }, run.replyTo);

	const monitor = (observation: Observation, watched: StartedRun, epic: Epic, replies: ReadonlyArray<Reply>) =>
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

				yield* Effect.log(
					Option.isSome(message)
						? `no reply to the agent's message for ${config.staleAfterSeconds} s; asking on Linear`
						: `agent ${status} without a result file; flagging it as awaitingInput`,
				);

				const question = yield* flag(
					observation,
					run,
					Option.match(message, {
						onNone: () => comments.awaitingInput(flaggedRun(observation, run, epic, tail, now)),
						onSome: (text) => comments.messageQuestion({ identifier: run.identifier, claimedAt: run.claimedAt, agentStatusSince: since, message: text }),
					}),
				);

				yield* journal.putRun({ ...run, status: 'awaitingInput', questionCommentId: question });

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

			if (run.status === 'awaitingInput' && run.questionCommentId !== null) {
				yield* deliverReplies(run, run.questionCommentId, replies);
			}
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter(
				(run): run is StartedRun => watchedStatuses.includes(run.status) && isStarted(run) && observation.teams.has(run.teamId) && observation.epics.has(run.epicId),
			);
			const questions = runs.flatMap((run) => (run.status === 'awaitingInput' && run.questionCommentId !== null ? [run.questionCommentId] : []));
			const replies = yield* linear.replies(questions);

			return runs.flatMap((run): Array<EpicWork> => {
				const epic = observation.epics.get(run.epicId);

				if (!epic) {
					return [];
				}

				const own = replies.filter((reply) => reply.parent.id === run.questionCommentId);

				return [{ epicId: run.epicId, identifier: run.identifier, teamId: run.teamId, apply: monitor(observation, run, epic, own) }];
			});
		});

	return { name: 'monitoring', pausable: false, plan } satisfies Rule;
});
