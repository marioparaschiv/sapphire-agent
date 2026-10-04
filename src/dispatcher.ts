import type { Claim, ClaimStore } from './claims.ts';
import { type Config, resolveRepo, type StateRole } from './config.ts';
import type { GitHub } from './github.ts';
import type { Epic, LinearClient, LinearTeam, Reply } from './linear.ts';
import type { DispatcherMessage, Job, Run, Send, WorkerMessage } from './protocol.ts';

export type DispatcherOptions = {
	config: Config;
	linear: LinearClient;
	claims: ClaimStore;
	send: Send<DispatcherMessage>;
	github: GitHub;
	isPaused: () => Promise<boolean>;
	now: () => number;
	log: (line: string) => void;
};

type ResolvedTeam = { team: LinearTeam; stateIds: Record<StateRole, string> };

const QUIET_STATUSES = new Set(['idle', 'done', 'blocked']);
// Claims whose agent may still be alive. They hold a maxInFlight slot so live Claude processes never exceed it.
const IN_FLIGHT_STATUSES = new Set<Claim['status']>(['claimed', 'running', 'awaitingInput', 'stale']);
// Every comment the dispatcher posts starts with this, which tells them apart from the user's: both are posted
// with the user's API key.
const COMMENT_MARKER = '**herdr-linear';
// Marks a reply to a question comment as typed into the pane, so it is delivered once across restarts.
const DELIVERED_EMOJI = 'white_check_mark';

// The only component that talks to Linear. Every tick and every worker message runs one at a time, so
// claim updates never interleave.
export class Dispatcher {
	private readonly options: DispatcherOptions;
	private teams = new Map<string, ResolvedTeam>();
	private queue: Promise<void> = Promise.resolve();
	private readonly warned = new Set<string>();
	private paused = false;
	private startedAt = 0;

	constructor(options: DispatcherOptions) {
		this.options = options;
	}

	// Re-attaches every claim that outlived the previous process.
	start() {
		this.startedAt = this.options.now();

		for (const claim of this.options.claims.all()) {
			if (claim.job && IN_FLIGHT_STATUSES.has(claim.status)) {
				this.options.send({ type: 'watch', job: claim.job, run: claim.run });
			}
		}
	}

	tick() {
		return this.serial('poll', async () => {
			this.teams = await this.resolveTeams();
			const { claims, linear } = this.options;
			const readyStateIds = [...this.teams.values()].map(({ stateIds }) => stateIds.ready);
			const { ready, claimed, replies } = await linear.poll(
				readyStateIds,
				claims.all().map((claim) => claim.epicId),
				claims.all().flatMap((claim) => (claim.status === 'awaitingInput' && claim.questionCommentId ? [claim.questionCommentId] : [])),
			);
			const claimedById = new Map(claimed.map((epic) => [epic.id, epic]));

			for (const claim of claims.all()) {
				await this.reconcile(claim, claimedById.get(claim.epicId));
			}

			await this.deliverReplies(replies);

			const paused = await this.options.isPaused();

			if (paused !== this.paused) {
				this.paused = paused;
				this.options.log(paused ? 'dispatching paused' : 'dispatching resumed');
			}

			if (!paused) {
				await this.dispatchReady(ready);
			}
		});
	}

	handle(message: WorkerMessage) {
		return this.serial(message.type, async () => {
			const { claims, now, log } = this.options;
			const claim = claims.get(message.epicId);

			if (!claim) {
				log(`ignoring ${message.type} for ${message.epicId}: no claim`);

				return;
			}

			switch (message.type) {
				case 'started': {
					await claims.put({ ...claim, status: 'running', run: message.run, agent: undefined });
					log(`${claim.identifier}: agent started in tab ${message.run.tabId}`);

					// An error claim here started after the start timeout flagged it.
					if (claim.status === 'claimed' || claim.status === 'error') {
						await this.move(claim, 'implementing');
					}

					return;
				}

				case 'status': {
					const previous = claim.agent;
					const stillQuiet = previous && QUIET_STATUSES.has(previous.status) && QUIET_STATUSES.has(message.status);
					const unchanged = previous && previous.status === message.status && sameOutput(previous.tail, message.tail);
					const progressed = !stillQuiet && !unchanged;
					const resumed =
						(claim.status === 'awaitingInput' && message.status === 'working') || (claim.status === 'stale' && progressed);

					await claims.put({
						...claim,
						status: resumed ? 'running' : claim.status,
						agent: { status: message.status, since: progressed || !previous ? now() : previous.since, tail: message.tail },
						nudgedAt: progressed ? undefined : claim.nudgedAt,
						questionCommentId: resumed ? undefined : claim.questionCommentId,
					});

					if (resumed) {
						log(`${claim.identifier}: agent is working again`);
					}

					return;
				}

				case 'finished': {
					await claims.put({ ...claim, agent: { status: message.reason, since: now(), tail: message.tail } });
					log(`${claim.identifier}: agent ${message.reason}`);

					return;
				}

				case 'failed': {
					if (claim.status === 'claimed') {
						await this.failStart(claim, message.error, message.tail);
					} else {
						log(`${claim.identifier}: failed to start after it was flagged: ${message.error}`);
					}

					return;
				}

				// A newer dispatch may have replaced the claim since the cleanup was sent.
				case 'cleaned': {
					if (claim.status === 'ended' || claim.status === 'kept') {
						await this.release(claim, 'its worktree is removed');
					}

					return;
				}

				case 'kept': {
					if (claim.status !== 'ended') {
						return;
					}

					log(`${claim.identifier}: kept ${message.worktreePath}: ${message.reason}`);
					await this.options.linear.comment(claim.epicId, keptComment(message.worktreePath, message.reason));
					await claims.put({ ...claim, status: 'kept' });

					return;
				}

				// Posting waits for the next poll, which retries it if GitHub fails.
				// The worker reads the file again after a restart.
				case 'result': {
					if (claim.result) {
						return;
					}

					if (!IN_FLIGHT_STATUSES.has(claim.status)) {
						log(`${claim.identifier}: ignoring a result file for a ${claim.status} claim`);

						return;
					}

					await claims.put({ ...claim, result: { file: message.result, posted: [] } });
					log(`${claim.identifier}: agent wrote its result file`);

					return;
				}

				case 'invalidResult': {
					if (!IN_FLIGHT_STATUSES.has(claim.status)) {
						return;
					}

					log(`${claim.identifier}: invalid result file: ${message.error}`);
					await claims.put({ ...claim, status: 'error' });
					await this.flag(claim, invalidResultComment(this.options.config, message.error));

					return;
				}

				case 'replyFailed': {
					log(`${claim.identifier}: typing reply ${message.commentId} failed: ${message.error}`);
					await this.options.linear.comment(claim.epicId, replyFailedComment(message.error), message.commentId);
				}
			}
		});
	}

	private serial(label: string, task: () => Promise<void>) {
		this.queue = this.queue.then(task).catch((error: unknown) => {
			this.options.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
		});

		return this.queue;
	}

	private warnOnce(message: string) {
		if (!this.warned.has(message)) {
			this.warned.add(message);
			this.options.log(message);
		}
	}

	private async resolveTeams() {
		const { config, linear } = this.options;
		const names = Object.keys(config.teams);
		const teams = await linear.teams(names);
		const resolved = new Map<string, ResolvedTeam>();

		for (const name of names) {
			const team = teams.find((candidate) => candidate.name === name);

			if (!team) {
				this.warnOnce(`team ${name} not found in Linear; skipping it`);
				continue;
			}

			const stateIds = {} as Record<StateRole, string>;
			const missing: string[] = [];

			for (const role of Object.keys(config.states) as StateRole[]) {
				const state = team.states.nodes.find((candidate) => candidate.name === config.states[role]);

				if (state) {
					stateIds[role] = state.id;
				} else {
					missing.push(JSON.stringify(config.states[role]));
				}
			}

			if (missing.length > 0) {
				this.warnOnce(`team ${name} has no workflow state ${missing.join(', ')}; skipping it until it does`);
				continue;
			}

			resolved.set(team.id, { team, stateIds });
		}

		return resolved;
	}

	private roleOf(claim: Claim, epic: Epic) {
		const stateIds = this.teams.get(claim.teamId)?.stateIds ?? {};

		return Object.entries(stateIds).find(([, id]) => id === epic.state.id)?.[0] as StateRole | undefined;
	}

	private stuckLabel(epic: Epic) {
		return epic.labels.nodes.find((label) => label.name === this.options.config.labels.stuck);
	}

	private async release(claim: Claim, reason: string) {
		this.options.log(`${claim.identifier}: ${reason}; releasing the claim`);
		await this.options.claims.delete(claim.epicId);
	}

	private async move(claim: Claim, role: StateRole) {
		const stateId = this.teams.get(claim.teamId)?.stateIds[role];

		if (!stateId) {
			throw new Error(`${claim.identifier}: team states are not resolved, cannot move to ${role}`);
		}

		await this.options.linear.moveIssue(claim.epicId, stateId);
		this.options.log(`${claim.identifier}: moved to ${this.options.config.states[role]}`);
	}

	private async failStart(claim: Claim, error: string, tail?: string) {
		this.options.log(`${claim.identifier}: failed to start: ${error}`);
		await this.options.claims.put({ ...claim, status: 'error' });
		await this.flag(claim, failureComment(this.options.config, error, tail));
	}

	// The run's tab is closed; the claim stays until the worktree is cleaned up.
	private async endRun(claim: Claim, job: Job, run: Run, reason: string) {
		this.options.log(`${claim.identifier}: ${reason}; ending the run`);
		await this.options.claims.put({ ...claim, status: 'ended' });
		this.options.send({ type: 'close', job, run });
	}

	private async flag(claim: Claim, comment: string) {
		const { linear, config } = this.options;

		const commentId = await linear.comment(claim.epicId, comment);
		await linear.addLabel(claim.epicId, claim.teamId, config.labels.stuck);

		return commentId;
	}

	private async reconcile(claim: Claim, epic: Epic | undefined) {
		if (!epic) {
			await this.release(claim, 'the epic no longer exists');

			return;
		}

		if (!this.teams.has(claim.teamId)) {
			return;
		}

		if (claim.status === 'claimed') {
			await this.checkStartTimeout(claim);

			return;
		}

		const role = this.roleOf(claim, epic);
		const { job, run } = claim;

		// Only a run that never started lacks these.
		if (!job || !run) {
			if (role !== 'ready') {
				await this.release(claim, `the epic moved to ${epic.state.name}`);
			} else if (!this.stuckLabel(epic)) {
				await this.release(claim, `the ${this.options.config.labels.stuck} label was removed`);
			}

			return;
		}

		if (claim.status === 'ended' || claim.status === 'kept') {
			await this.checkCleanup(job, run, role);

			return;
		}

		if (claim.status !== 'error' && !claim.overCap && this.options.now() - claim.claimedAt >= this.options.config.maxRunSeconds * 1000) {
			await this.flagOverCap(claim);

			return;
		}

		if (role === 'ready' && claim.status === 'running') {
			await this.move(claim, 'implementing');

			return;
		}

		// Closing a working agent's tab would kill it mid-turn, so a run only ends once the agent is not working.
		const working = !claim.agent || claim.agent.status === 'working';

		if (role !== 'implementing' && role !== 'inReview') {
			if (!working) {
				await this.endRun(claim, job, run, `the epic moved to ${epic.state.name}`);
			}

			return;
		}

		if (claim.result) {
			if (!working) {
				await this.finishRun(claim, claim.result, epic, job, run);
			}

			return;
		}

		const { agent } = claim;

		if (!agent || claim.status === 'error') {
			return;
		}

		if (agent.status === 'exited' || agent.status === 'vanished') {
			await this.flagRun(claim, run, agent, 'error');
		} else if (claim.status === 'running' && this.quietTooLong(agent)) {
			await this.flagRun(claim, run, agent, 'awaitingInput');
		} else if (claim.status === 'running' && agent.status === 'working') {
			await this.checkStale(claim, job, run, agent);
		}
	}

	// Posts the result file to the PR, then hands the epic over. Each posted part is saved straight away, so a
	// restart mid-way carries on without posting anything twice.
	private async finishRun(claim: Claim, result: ClaimResult, epic: Epic, job: Job, run: Run) {
		const { github, claims, log } = this.options;
		const pullRequest = await github.findPullRequest(run.githubRepo, run.branch);

		if (!pullRequest || pullRequest.state === 'CLOSED') {
			log(`${claim.identifier}: result file written but no open PR for ${run.branch}`);
			await claims.put({ ...claim, status: 'error' });
			await this.flag(claim, noPullRequestComment(this.options.config, run.branch));

			return;
		}

		let posted = result.posted;
		const save = async (part: (typeof posted)[number]) => {
			posted = [...posted, part];
			await claims.put({ ...claim, result: { ...result, posted } });
		};

		if (!posted.includes('summary')) {
			await github.comment(run.githubRepo, pullRequest.number, result.file.summary);
			await save('summary');
		}

		if (result.file.flags.length > 0 && !posted.includes('review')) {
			await github.review(run.githubRepo, pullRequest.number, result.file.flags);
			await save('review');
		}

		if (result.file.replies.length > 0) {
			log(`${claim.identifier}: the result file has ${result.file.replies.length} thread replies; posting them is not supported yet`);
		}

		log(`${claim.identifier}: posted the result to ${pullRequest.url}`);
		await this.move(claim, 'toReview');

		const stuckLabel = this.stuckLabel(epic);

		if (stuckLabel) {
			await this.options.linear.removeLabel(claim.epicId, stuckLabel.id);
		}

		await this.endRun({ ...claim, result: { ...result, posted } }, job, run, 'the agent finished');
	}

	// Nudges once per stale episode; the status handler clears nudgedAt as soon as the pane changes.
	private async checkStale(claim: Claim, job: Job, run: Run, agent: Agent) {
		const { config, claims, now, send, log } = this.options;

		if (claim.nudgedAt === undefined) {
			if (now() - agent.since >= config.staleAfterSeconds * 1000) {
				log(`${claim.identifier}: no new output for ${config.staleAfterSeconds} s; nudging the agent`);
				await claims.put({ ...claim, nudgedAt: now() });
				send({ type: 'nudge', job, run });
			}

			return;
		}

		if (now() - claim.nudgedAt >= config.nudgeGraceSeconds * 1000) {
			await this.flagRun(claim, run, agent, 'stale');
		}
	}

	private async flagOverCap(claim: Claim) {
		const { config, claims, now, log } = this.options;

		log(`${claim.identifier}: running for over ${config.maxRunSeconds} s; flagging it`);
		await this.flag(claim, overCapComment(config, claim, now()));
		await claims.put({ ...claim, overCap: true });
	}

	// Types each new reply to a question comment into its pane. The reaction goes on first: a reply is never
	// typed twice, and if typing fails the worker says so and the user is told in the thread.
	private async deliverReplies(replies: Reply[]) {
		const { claims, linear, send, log } = this.options;
		const sorted = replies.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

		for (const reply of sorted) {
			const claim = claims.all().find((candidate) => candidate.questionCommentId === reply.parent.id);
			const delivered = reply.reactions.some((reaction) => reaction.emoji === DELIVERED_EMOJI);

			if (!claim?.job || !claim.run || claim.status !== 'awaitingInput' || delivered || reply.body.startsWith(COMMENT_MARKER)) {
				continue;
			}

			await linear.react(reply.id, DELIVERED_EMOJI);
			send({ type: 'reply', job: claim.job, run: claim.run, commentId: reply.id, text: reply.body });
			log(`${claim.identifier}: sent reply ${reply.id} to the agent`);
		}
	}

	// After a restart the worker gets a full window to adopt the run before it counts as never started.
	private async checkStartTimeout(claim: Claim) {
		const { config, now } = this.options;
		const waitingSince = Math.max(claim.claimedAt, this.startedAt);

		if (now() - waitingSince >= config.startTimeoutSeconds * 1000) {
			await this.failStart(claim, `the agent was not confirmed running within ${config.startTimeoutSeconds} s`);
		}
	}

	// Sent every poll until the worker reports the worktree removed, so a kept worktree goes once its work is pushed.
	private async checkCleanup(job: Job, run: Run, role: StateRole | undefined) {
		if (role !== 'shipped') {
			const pullRequest = await this.options.github.findPullRequest(run.githubRepo, run.branch);

			if (pullRequest?.state !== 'MERGED' && pullRequest?.state !== 'CLOSED') {
				return;
			}
		}

		this.options.send({ type: 'cleanup', job, run });
	}

	private async flagRun(claim: Claim, run: Run, agent: Agent, status: FlaggedStatus) {
		this.options.log(`${claim.identifier}: agent ${agent.status} without a result file; flagging it as ${status}`);
		const commentId = await this.flag(claim, runComment(this.options.config, status, claim, agent, run, this.options.now()));
		await this.options.claims.put({ ...claim, status, questionCommentId: status === 'awaitingInput' ? commentId : undefined });
	}

	private quietTooLong(agent: Agent) {
		const { config, now } = this.options;

		return QUIET_STATUSES.has(agent.status) && now() - agent.since >= config.awaitingInputAfterSeconds * 1000;
	}

	private async dispatchReady(ready: Epic[]) {
		const { claims, config, send, now, log } = this.options;
		let inFlight = claims.all().filter((claim) => IN_FLIGHT_STATUSES.has(claim.status)).length;
		const runOver = (claim: Claim | undefined) => !claim || claim.status === 'ended' || claim.status === 'kept';
		const candidates = ready
			.filter((epic) => this.teams.has(epic.team.id) && runOver(claims.get(epic.id)) && !this.stuckLabel(epic))
			.sort((a, b) => a.sortOrder - b.sortOrder);

		for (const epic of candidates) {
			if (epic.children.nodes.length === 0) {
				this.warnOnce(`${epic.identifier} is in ${config.states.ready} but has no sub-issues; ignoring it`);
				continue;
			}

			if (inFlight >= config.maxInFlight) {
				return;
			}

			const claim: Claim = {
				epicId: epic.id,
				identifier: epic.identifier,
				teamId: epic.team.id,
				status: 'claimed',
				claimedAt: now(),
			};
			const repo = resolveRepo(config, epic.team.name, epic.labels.nodes);

			if (!repo.ok) {
				await this.failStart(claim, repo.error);
				continue;
			}

			const job = buildJob(epic, repo.path);

			await claims.put({ ...claim, job });
			inFlight += 1;
			send({ type: 'dispatch', job });
			log(`${epic.identifier}: dispatched to ${repo.path} on ${epic.branchName}`);
		}
	}
}

export function buildJob(epic: Epic, repoPath: string): Job {
	const shortTitle = epic.title.length > 40 ? `${epic.title.slice(0, 39).trimEnd()}…` : epic.title;

	// The orchestrate skill owns the workflow (Linear moves, commits, /pr). herdr refuses newlines in the prompt.
	const prompt = `/orchestrate the sub-issues of Linear epic ${epic.identifier} (${epic.url}) autonomously, in the worktree you are in.`;

	return {
		epicId: epic.id,
		identifier: epic.identifier,
		branch: epic.branchName,
		repoPath,
		tabLabel: `${epic.identifier} ${shortTitle}`,
		prompt,
	};
}

// Claude's spinner glyph, its elapsed timer and the status line's counters tick even while a turn hangs,
// so they are not progress.
const withoutTickers = (tail: string) => tail.replace(/[\d·✢✳✶✻✽]/g, '');

const sameOutput = (a: string, b: string) => withoutTickers(a) === withoutTickers(b);

const codeBlock = (text: string) => `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;

type Agent = NonNullable<Claim['agent']>;

type ClaimResult = NonNullable<Claim['result']>;

type FlaggedStatus = 'awaitingInput' | 'stale' | 'error';

function describeStop(agent: Agent, now: number) {
	const minutes = Math.round((now - agent.since) / 60_000);

	switch (agent.status) {
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
		default:
			return 'stopped';
	}
}

const startOver = (config: Config) => `Remove the label and move the epic back to ${config.states.ready} to start over.`;

function runComment(config: Config, status: FlaggedStatus, claim: Claim, agent: Agent, run: Run, now: number) {
	const next = {
		awaitingInput: `Reply to this comment and the reply is typed into the agent's pane. Or: ${startOver(config)}`,
		stale: `Look at the agent in its tab. Or: ${startOver(config)}`,
		error: startOver(config),
	}[status];

	return [
		`**herdr-linear** (\`${status}\`): the agent ${describeStop(agent, now)} before writing its result file.`,
		'',
		`- Tab: \`${claim.job?.tabLabel}\` (${run.tabId}), pane ${run.paneId}`,
		`- Worktree: \`${run.worktreePath}\` on branch \`${run.branch}\``,
		'',
		'Last lines of the pane:',
		'',
		codeBlock(agent.tail),
		'',
		`The epic keeps the \`${config.labels.stuck}\` label. ${next}`,
	].join('\n');
}

function overCapComment(config: Config, claim: Claim, now: number) {
	return [
		`**herdr-linear** (\`${claim.status}\`): the run has been going for ${Math.round((now - claim.claimedAt) / 60_000)} min, over the ${config.maxRunSeconds / 60} min cap. It keeps running.`,
		'',
		'Last lines of the pane:',
		'',
		codeBlock(claim.agent?.tail ?? ''),
		'',
		`Look at the agent in its tab. Or: ${startOver(config)}`,
	].join('\n');
}

function invalidResultComment(config: Config, error: string) {
	return [`**herdr-linear** (\`error\`): the agent's result file is invalid:`, '', codeBlock(error), '', startOver(config)].join('\n');
}

function noPullRequestComment(config: Config, branch: string) {
	return `**herdr-linear** (\`error\`): the agent wrote its result file, but branch \`${branch}\` has no open or merged PR. ${startOver(config)}`;
}

function replyFailedComment(error: string) {
	return `**herdr-linear:** couldn't type this reply into the agent's pane: ${error}. Answer the agent in its tab.`;
}

function failureComment(config: Config, error: string, tail?: string) {
	return [
		`**herdr-linear** (\`error\`): couldn't start an agent for this epic: ${error}`,
		...(tail ? ['', 'Last lines of the pane:', '', codeBlock(tail)] : []),
		'',
		`Fix the problem, then remove the \`${config.labels.stuck}\` label to retry.`,
	].join('\n');
}

function keptComment(worktreePath: string, reason: string) {
	return `**herdr-linear:** kept the worktree \`${worktreePath}\` because it has ${reason}. Push or discard that work and it is removed on a later poll.`;
}
