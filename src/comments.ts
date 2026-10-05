import { Context, Layer, Option } from 'effect';
import { AppConfig, type AppConfigShape } from './config.ts';
import type { AgentStatus, Job, RunStatus } from './journal.ts';
import { type MarkedComment, withMarker } from './markers.ts';
import type { ResultFile } from './result-file.ts';

// The run a flag is about, as the user sees it in herdr.
export type FlaggedRun = {
	readonly identifier: string;
	readonly claimedAt: number;
	readonly tabLabel: string;
	readonly tabId: string;
	readonly paneId: string;
	readonly worktreePath: string;
	readonly branch: string;
	readonly agentStatus: AgentStatus;
	readonly agentStatusSince: number;
	// The last lines of the pane.
	readonly tail: string;
	readonly now: number;
};

const minutesBetween = (from: number, to: number) => Math.round((to - from) / 60_000);

const codeBlock = (text: string) => `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;

const describeStop = (status: AgentStatus, minutes: number) => {
	switch (status) {
		case 'idle':
			return `has been idle for ${minutes} min`;
		case 'done':
			return `finished its turn ${minutes} min ago`;
		case 'blocked':
			return `has been waiting for input for ${minutes} min`;
		case 'working':
			return `has shown no new output for ${minutes} min, even after a nudge`;
		case 'exited':
			return 'exited';
		case 'vanished':
			return 'disappeared (its tab was closed or herdr restarted)';
		case 'unknown':
			return 'stopped';
	}
};

// Why the replies do not answer exactly the dispatched threads, once each; none when they do.
export const replyMismatch = (threadIds: ReadonlyArray<string>, replies: ResultFile['replies']): Option.Option<string> => {
	const replied = replies.map((reply) => reply.threadId);
	const problems = [
		['no reply for', threadIds.filter((id) => !replied.includes(id))],
		['replies to threads it was not given', [...new Set(replied.filter((id) => !threadIds.includes(id)))]],
		['more than one reply for', [...new Set(replied.filter((id, index) => replied.indexOf(id) !== index))]],
	] as const;
	const found = problems.filter(([, ids]) => ids.length > 0);

	return found.length > 0 ? Option.some(found.map(([problem, ids]) => `${problem} ${ids.join(', ')}`).join('; ')) : Option.none();
};

const make = (config: AppConfigShape) => {
	const startOver = `Remove the label and move the epic back to ${config.states.ready} to start over.`;
	const retryAfterFix = `Fix the problem, then remove the \`${config.labels.stuck}\` label to retry.`;

	const runFlag = (run: FlaggedRun, status: 'awaitingInput' | 'stale' | 'error', next: string) =>
		[
			`**sapphire-agent** (\`${status}\`): the agent ${describeStop(run.agentStatus, minutesBetween(run.agentStatusSince, run.now))} before writing its result file.`,
			'',
			`- Tab: \`${run.tabLabel}\` (${run.tabId}), pane ${run.paneId}`,
			`- Worktree: \`${run.worktreePath}\` on branch \`${run.branch}\``,
			'',
			'Last lines of the pane:',
			'',
			codeBlock(run.tail),
			'',
			`The epic keeps the \`${config.labels.stuck}\` label. ${next}`,
		].join('\n');

	return {
		// Its replies are typed into the pane, so the flag's id is kept as the run's question.
		awaitingInput: (run: FlaggedRun) =>
			withMarker(runFlag(run, 'awaitingInput', `Reply to this comment and the reply is typed into the agent's pane. Or: ${startOver}`), {
				identifier: run.identifier,
				purpose: 'awaitingInput',
				key: `${run.claimedAt}-${run.agentStatusSince}`,
			}),

		stale: (run: FlaggedRun & { readonly nudgedAt: number }) =>
			withMarker(runFlag(run, 'stale', `Look at the agent in its tab. Or: ${startOver}`), {
				identifier: run.identifier,
				purpose: 'stale',
				key: `${run.claimedAt}-${run.nudgedAt}`,
			}),

		// The agent exited or vanished without a result file.
		agentStopped: (run: FlaggedRun) =>
			withMarker(runFlag(run, 'error', startOver), { identifier: run.identifier, purpose: 'error', key: `${run.claimedAt}` }),

		overCap: (run: { readonly identifier: string; readonly claimedAt: number; readonly status: RunStatus; readonly tail: string; readonly now: number }) =>
			withMarker(
				[
					`**sapphire-agent** (\`${run.status}\`): the run has been going for ${minutesBetween(run.claimedAt, run.now)} min, over the ${config.maxRunSeconds / 60} min cap. It keeps running.`,
					'',
					'Last lines of the pane:',
					'',
					codeBlock(run.tail),
					'',
					`Look at the agent in its tab. Or: ${startOver}`,
				].join('\n'),
				{ identifier: run.identifier, purpose: 'overCap', key: `${run.claimedAt}` },
			),

		startFailed: (run: { readonly identifier: string; readonly claimedAt: number; readonly error: string; readonly tail: Option.Option<string> }) =>
			withMarker(
				[
					`**sapphire-agent** (\`error\`): couldn't start an agent for this epic: ${run.error}`,
					...Option.match(run.tail, { onNone: () => [], onSome: (tail) => ['', 'Last lines of the pane:', '', codeBlock(tail)] }),
					'',
					retryAfterFix,
				].join('\n'),
				{ identifier: run.identifier, purpose: 'startFailed', key: `${run.claimedAt}` },
			),

		invalidResult: (run: { readonly identifier: string; readonly claimedAt: number; readonly error: string }) =>
			withMarker([`**sapphire-agent** (\`error\`): the agent's result file is invalid:`, '', codeBlock(run.error), '', startOver].join('\n'), {
				identifier: run.identifier,
				purpose: 'invalidResult',
				key: `${run.claimedAt}`,
			}),

		noPullRequest: (run: { readonly identifier: string; readonly claimedAt: number; readonly branch: string }) =>
			withMarker(`**sapphire-agent** (\`error\`): the agent wrote its result file, but branch \`${run.branch}\` has no open or merged PR. ${startOver}`, {
				identifier: run.identifier,
				purpose: 'noPullRequest',
				key: `${run.claimedAt}`,
			}),

		// `mismatch` comes from replyMismatch.
		threadMismatch: (run: { readonly identifier: string; readonly claimedAt: number; readonly job: Job; readonly mismatch: string }) =>
			withMarker(
				`**sapphire-agent** (\`error\`): the agent's result file does not match the review threads it was given: ${run.mismatch}. Nothing was posted to the PR. ${
					run.job._tag === 'follow-up'
						? `Remove the label, move the epic to ${config.states.toReview} and mention @${config.bot.login} to ask for the follow-up again.`
						: startOver
				}`,
				{ identifier: run.identifier, purpose: 'threadMismatch', key: `${run.claimedAt}` },
			),

		// Posted under the question comment the reply belongs to.
		replyFailed: (reply: { readonly identifier: string; readonly replyCommentId: string; readonly error: string }) =>
			withMarker(`**sapphire-agent:** couldn't type your last reply into the agent's pane: ${reply.error}. Answer the agent in its tab.`, {
				identifier: reply.identifier,
				purpose: 'replyFailed',
				key: reply.replyCommentId,
			}),

		// `claimedAt` is none for an orphan worktree that no run tracks.
		keptWorktree: (kept: { readonly identifier: string; readonly claimedAt: Option.Option<number>; readonly worktreePath: string; readonly reason: string }) =>
			withMarker(
				`**sapphire-agent:** kept the worktree \`${kept.worktreePath}\` because it has ${kept.reason}. Push or discard that work and it is removed on a later poll.`,
				{
					identifier: kept.identifier,
					purpose: 'keptWorktree',
					key: Option.match(kept.claimedAt, { onNone: () => kept.worktreePath, onSome: (claimedAt) => `${claimedAt}` }),
				},
			),

		// `streakStartedAt` is what Journal.recordTransient returns.
		transientFailure: (failure: { readonly identifier: string; readonly streakStartedAt: number; readonly error: string; readonly now: number }) =>
			withMarker(
				`**sapphire-agent** (\`error\`): calls for this epic have been failing for ${minutesBetween(failure.streakStartedAt, failure.now)} min: ${failure.error}. It keeps retrying on every poll; this comment is not repeated.`,
				{ identifier: failure.identifier, purpose: 'transientFailure', key: `${failure.streakStartedAt}` },
			),

		permanentFailure: (failure: { readonly identifier: string; readonly claimedAt: number; readonly error: string }) =>
			withMarker(`**sapphire-agent** (\`error\`): a call for this epic failed and retrying cannot help: ${failure.error}\n\n${retryAfterFix}`, {
				identifier: failure.identifier,
				purpose: 'permanentFailure',
				key: `${failure.claimedAt}`,
			}),

		workingOrphan: (tab: { readonly identifier: string; readonly tabLabel: string; readonly tabId: string; readonly paneId: string }) =>
			withMarker(
				`**sapphire-agent:** the agent in tab \`${tab.tabLabel}\` (${tab.tabId}), pane ${tab.paneId}, is working, but no run of this epic tracks it. It is left running, and its tab is closed once the agent stops working.`,
				{ identifier: tab.identifier, purpose: 'workingOrphan', key: tab.tabId },
			),

		// GitHub refuses review requests from the PR's author, which is the user's own account, so a mention notifies them.
		summary: (run: { readonly identifier: string; readonly claimedAt: number; readonly summary: string; readonly authorLogin: string }) =>
			withMarker(`${run.summary}\n\nReady for review, @${run.authorLogin}.`, { identifier: run.identifier, purpose: 'summary', key: `${run.claimedAt}` }),

		// The body of the one review that holds every flag as an inline comment.
		flagsReview: (run: { readonly identifier: string; readonly claimedAt: number }) =>
			withMarker('Self-review findings I did not fix in this PR.', { identifier: run.identifier, purpose: 'flags', key: `${run.claimedAt}` }),

		threadReply: (reply: { readonly identifier: string; readonly claimedAt: number; readonly threadId: string; readonly body: string }) =>
			withMarker(reply.body, { identifier: reply.identifier, purpose: 'reply', key: `${reply.threadId}.${reply.claimedAt}` }),

		// What a command's agent asked to say, posted by the bot.
		commandReply: (reply: { readonly identifier: string; readonly requestId: number; readonly body: string }) =>
			withMarker(reply.body, { identifier: reply.identifier, purpose: 'commandReply', key: `${reply.requestId}` }),

		// Posted by the bot when a command ends without its agent saying it was done.
		commandFailed: (command: { readonly identifier: string; readonly claimedAt: number; readonly reason: string; readonly tail: Option.Option<string> }) =>
			withMarker(
				[
					`**sapphire-agent** (\`error\`): ${command.identifier} ${command.reason}, so I stopped it.`,
					...Option.match(command.tail, { onNone: () => [], onSome: (tail) => ['', 'Last lines of the pane:', '', codeBlock(tail)] }),
					'',
					`Mention @${config.bot.login} again to retry.`,
				].join('\n'),
				{ identifier: command.identifier, purpose: 'commandFailed', key: `${command.claimedAt}` },
			),
	} satisfies Record<string, (...args: never) => MarkedComment>;
};

// Every Linear and PR comment sapphire-agent writes, each ending with its marker (see markers.ts for the keys).
export class Comments extends Context.Service<Comments, ReturnType<typeof make>>()('sapphire-agent/Comments') {
	static readonly layer = Layer.effect(Comments, AppConfig.useSync(make));
}
