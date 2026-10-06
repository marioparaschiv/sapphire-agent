import { Context, Layer, Option } from 'effect';
import { AppConfig, type AppConfigShape } from './config.ts';
import { oneLine } from './herdr.ts';
import type { AgentStatus, Job, RunStatus } from './journal.ts';
import { type MarkedComment, type Marker, type Notice, withMarker } from './markers.ts';
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

// A message lists at most this many items, so it reads at a glance.
const maxItems = 5;

const tailLines = 10;

// The end of a pane's tail a message shows.
export const shownTail = (tail: string) => tail.split('\n').slice(-tailLines).join('\n');

export const itemList = (items: ReadonlyArray<string>) =>
	items.length <= maxItems ? items.map((item) => `- ${item}`) : [...items.slice(0, maxItems - 1).map((item) => `- ${item}`), `- …and ${items.length - maxItems + 1} more`];

const minutesBetween = (from: number, to: number) => Math.round((to - from) / 60_000);

const withoutPrefix = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text);

const codeBlock = (text: string) => `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;

// First line the cause, then the details, then the one thing to do next.
type NoticeParts = {
	readonly title: string;
	readonly items?: ReadonlyArray<string>;
	readonly body?: string;
	// Shown as a code block, cut to its last lines.
	readonly block?: Option.Option<string>;
	readonly next: string;
};

const notice = (marker: Marker, { title, items = [], body, block = Option.none(), next }: NoticeParts): Notice => ({
	marker,
	text: [title, ...itemList(items), ...(body === undefined ? [] : [body]), ...Option.match(block, { onNone: () => [], onSome: (text) => [codeBlock(shownTail(text))] }), `Next: ${next}`].join('\n'),
});

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
	const startOver = `Remove the \`${config.labels.stuck}\` label and move the epic back to ${config.states.ready} to start over.`;
	const retryAfterFix = `Fix the problem, then remove the \`${config.labels.stuck}\` label to retry.`;

	const runFlag = (run: FlaggedRun, title: string, purpose: 'awaitingInput' | 'stale' | 'error', key: string, next: string) =>
		notice(
			{ identifier: run.identifier, purpose, key },
			{
				title: `${title}: the agent ${describeStop(run.agentStatus, minutesBetween(run.agentStatusSince, run.now))} without writing its result file.`,
				items: [`Tab: \`${run.tabLabel}\` (${run.tabId}), pane ${run.paneId}`, `Worktree: \`${run.worktreePath}\` on \`${run.branch}\``, `Label: \`${config.labels.stuck}\``],
				block: Option.some(run.tail),
				next,
			},
		);

	return {
		awaitingInput: (run: FlaggedRun) => runFlag(run, `⏸ **${run.identifier} needs input**`, 'awaitingInput', `${run.claimedAt}-${run.agentStatusSince}`, 'Answer the agent in its tab.'),

		// The question a run sent its reply-to session by message, which no one answered, while the epic has no topic to ask in.
		messageQuestion: (run: Pick<FlaggedRun, 'identifier' | 'claimedAt' | 'agentStatusSince'> & { readonly message: string }) =>
			notice(
				{ identifier: run.identifier, purpose: 'awaitingInput', key: `${run.claimedAt}-${run.agentStatusSince}` },
				{ title: `❓ **${run.identifier} asks:** ${withoutPrefix(oneLine(run.message), `${run.identifier}:`)}`, next: 'Answer the agent in its tab.' },
			),

		stale: (run: FlaggedRun & { readonly nudgedAt: number }) =>
			runFlag(run, `🔴 **${run.identifier} looks stuck**`, 'stale', `${run.claimedAt}-${run.nudgedAt}`, 'Look at the agent in its tab.'),

		// The agent exited or vanished without a result file.
		agentStopped: (run: FlaggedRun) => runFlag(run, `🔴 **${run.identifier} stopped**`, 'error', `${run.claimedAt}`, startOver),

		overCap: (run: { readonly identifier: string; readonly claimedAt: number; readonly status: RunStatus; readonly tail: string; readonly now: number }) =>
			notice(
				{ identifier: run.identifier, purpose: 'overCap', key: `${run.claimedAt}` },
				{
					title: `⏰ **${run.identifier} is over the time cap**: ${minutesBetween(run.claimedAt, run.now)} min, cap ${config.maxRunSeconds / 60} min. It keeps running.`,
					items: [`Status: \`${run.status}\``],
					block: Option.some(run.tail),
					next: 'Look at the agent in its tab.',
				},
			),

		startFailed: (run: { readonly identifier: string; readonly claimedAt: number; readonly error: string; readonly tail: Option.Option<string> }) =>
			notice(
				{ identifier: run.identifier, purpose: 'startFailed', key: `${run.claimedAt}` },
				{ title: `🔴 **${run.identifier} didn't start**: ${run.error}`, block: run.tail, next: retryAfterFix },
			),

		invalidResult: (run: { readonly identifier: string; readonly claimedAt: number; readonly error: string }) =>
			notice(
				{ identifier: run.identifier, purpose: 'invalidResult', key: `${run.claimedAt}` },
				{ title: `🔴 **${run.identifier} wrote an invalid result file**`, block: Option.some(run.error), next: startOver },
			),

		noPullRequest: (run: { readonly identifier: string; readonly claimedAt: number; readonly branch: string }) =>
			notice(
				{ identifier: run.identifier, purpose: 'noPullRequest', key: `${run.claimedAt}` },
				{ title: `🔴 **${run.identifier} has no PR**: the agent wrote its result file, but \`${run.branch}\` has no open or merged PR.`, next: startOver },
			),

		// `mismatch` comes from replyMismatch.
		threadMismatch: (run: { readonly identifier: string; readonly claimedAt: number; readonly job: Job; readonly mismatch: string }) =>
			notice(
				{ identifier: run.identifier, purpose: 'threadMismatch', key: `${run.claimedAt}` },
				{
					title: `🔴 **${run.identifier}'s replies don't match its review threads**: ${run.mismatch}. Nothing was posted to the PR.`,
					next:
						run.job._tag === 'follow-up'
							? `Remove the \`${config.labels.stuck}\` label, move the epic to ${config.states.toReview} and ask for the follow-up again.`
							: startOver,
				},
			),

		// `claimedAt` is none for an orphan worktree that no run tracks.
		keptWorktree: (kept: { readonly identifier: string; readonly claimedAt: Option.Option<number>; readonly worktreePath: string; readonly reason: string }) =>
			notice(
				{
					identifier: kept.identifier,
					purpose: 'keptWorktree',
					key: Option.match(kept.claimedAt, { onNone: () => kept.worktreePath, onSome: (claimedAt) => `${claimedAt}` }),
				},
				{
					title: `📦 **Kept ${kept.identifier}'s worktree**: it has ${kept.reason}.`,
					items: [`Worktree: \`${kept.worktreePath}\``],
					next: 'Push or discard that work; the worktree is removed on a later poll.',
				},
			),

		// `streakStartedAt` is what Journal.recordTransient returns.
		transientFailure: (failure: { readonly identifier: string; readonly streakStartedAt: number; readonly error: string; readonly now: number }) =>
			notice(
				{ identifier: failure.identifier, purpose: 'transientFailure', key: `${failure.streakStartedAt}` },
				{
					title: `⚠️ **${failure.identifier}'s calls keep failing** for ${minutesBetween(failure.streakStartedAt, failure.now)} min: ${failure.error}`,
					next: 'Nothing unless it lasts; it retries on every poll.',
				},
			),

		permanentFailure: (failure: { readonly identifier: string; readonly claimedAt: number; readonly error: string }) =>
			notice(
				{ identifier: failure.identifier, purpose: 'permanentFailure', key: `${failure.claimedAt}` },
				{ title: `🔴 **A call for ${failure.identifier} failed for good**: ${failure.error}`, next: retryAfterFix },
			),

		workingOrphan: (tab: { readonly identifier: string; readonly tabLabel: string; readonly tabId: string; readonly paneId: string }) =>
			notice(
				{ identifier: tab.identifier, purpose: 'workingOrphan', key: tab.tabId },
				{
					title: `👻 **An untracked agent works on ${tab.identifier}**: no run of the epic tracks it.`,
					items: [`Tab: \`${tab.tabLabel}\` (${tab.tabId}), pane ${tab.paneId}`],
					next: 'Let it finish; its tab is closed once it stops working.',
				},
			),

		summary: (run: { readonly identifier: string; readonly claimedAt: number; readonly summary: string; readonly url: string }) =>
			notice(
				{ identifier: run.identifier, purpose: 'summary', key: `${run.claimedAt}` },
				{ title: `✅ **${run.identifier} is ready for review**: ${run.url}`, body: run.summary, next: 'Review the PR.' },
			),

		// The self-review findings the run did not fix.
		flags: (run: { readonly identifier: string; readonly claimedAt: number; readonly flags: ResultFile['flags'] }) =>
			notice(
				{ identifier: run.identifier, purpose: 'flags', key: `${run.claimedAt}` },
				{
					title: `🔎 **${run.identifier} left ${run.flags.length} self-review ${run.flags.length === 1 ? 'finding' : 'findings'} unfixed**`,
					items: run.flags.map(({ path, line, body }) => `\`${path}:${line}\` ${oneLine(body)}`),
					next: 'Ask for a follow-up to fix any of them.',
				},
			),

		// Once per PR, whichever run sees it first.
		pullRequestOpened: (pullRequest: { readonly identifier: string; readonly url: string }) =>
			withMarker(`PR opened: ${pullRequest.url}`, { identifier: pullRequest.identifier, purpose: 'pullRequestOpened', key: pullRequest.url }),

		threadReply: (reply: { readonly identifier: string; readonly claimedAt: number; readonly threadId: string; readonly body: string }) =>
			withMarker(reply.body, { identifier: reply.identifier, purpose: 'reply', key: `${reply.threadId}.${reply.claimedAt}` }),

		// The one PR comment of a run that replied to review threads.
		addressed: (run: { readonly identifier: string; readonly claimedAt: number }) =>
			withMarker('Addressed your concerns inline.', { identifier: run.identifier, purpose: 'addressed', key: `${run.claimedAt}` }),

		// What a command's agent asked to say.
		commandReply: (reply: { readonly identifier: string; readonly requestId: number; readonly url: string; readonly body: string }): Notice => ({
			marker: { identifier: reply.identifier, purpose: 'commandReply', key: `${reply.requestId}` },
			text: [`💬 **${reply.identifier}** on ${reply.url}`, reply.body].join('\n'),
		}),

		// A command that ended without its agent saying it was done.
		commandFailed: (command: { readonly identifier: string; readonly claimedAt: number; readonly url: string; readonly reason: string; readonly tail: Option.Option<string> }) =>
			notice(
				{ identifier: command.identifier, purpose: 'commandFailed', key: `${command.claimedAt}` },
				{
					title: `🔴 **${command.identifier} ${command.reason}**, so I stopped it.`,
					items: [`Comment: ${command.url}`],
					block: command.tail,
					next: `Mention @${config.bot.login} again to retry.`,
				},
			),
	} satisfies Record<string, (...args: never) => MarkedComment | Notice>;
};

// Every notice, and the few Linear and PR comments, sapphire-agent writes, each with its marker (see markers.ts for the
// keys).
export class Comments extends Context.Service<Comments, ReturnType<typeof make>>()('sapphire-agent/Comments') {
	static readonly layer = Layer.effect(Comments, AppConfig.useSync(make));
}
