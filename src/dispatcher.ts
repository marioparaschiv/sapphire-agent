import type { Claim, ClaimStore } from './claims.ts';
import { type Config, resolveRepo, type StateRole } from './config.ts';
import type { PullRequest } from './github.ts';
import type { Epic, LinearClient, LinearTeam } from './linear.ts';
import type { DispatcherMessage, Job, Run, Send, WorkerMessage } from './protocol.ts';

export type DispatcherOptions = {
	config: Config;
	linear: LinearClient;
	claims: ClaimStore;
	send: Send<DispatcherMessage>;
	findPullRequest: (githubRepo: string, branch: string) => Promise<PullRequest | undefined>;
	isPaused: () => Promise<boolean>;
	now: () => number;
	log: (line: string) => void;
};

type ResolvedTeam = { team: LinearTeam; stateIds: Record<StateRole, string> };

const QUIET_STATUSES = new Set(['idle', 'done', 'blocked']);
// Claims whose agent may still be alive. They hold a maxInFlight slot so live Claude processes never exceed it.
const IN_FLIGHT_STATUSES = new Set<Claim['status']>(['claimed', 'running', 'awaitingInput', 'stale']);

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
			const { ready, claimed } = await linear.poll(
				readyStateIds,
				claims.all().map((claim) => claim.epicId),
			);
			const claimedById = new Map(claimed.map((epic) => [epic.id, epic]));

			for (const claim of claims.all()) {
				await this.reconcile(claim, claimedById.get(claim.epicId));
			}

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
					const since = stillQuiet ? previous.since : now();
					const resumed = claim.status === 'awaitingInput' && message.status === 'working';

					await claims.put({
						...claim,
						status: resumed ? 'running' : claim.status,
						agent: { status: message.status, since, tail: message.tail },
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

		await linear.comment(claim.epicId, comment);
		await linear.addLabel(claim.epicId, claim.teamId, config.labels.stuck);
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

		const pullRequest = await this.options.findPullRequest(run.githubRepo, run.branch);

		if (pullRequest && pullRequest.state !== 'CLOSED') {
			if (working) {
				return;
			}

			this.options.log(`${claim.identifier}: PR ${pullRequest.url} is ${pullRequest.state.toLowerCase()}`);
			await this.move(claim, 'toReview');

			const stuckLabel = this.stuckLabel(epic);

			if (stuckLabel) {
				await this.options.linear.removeLabel(claim.epicId, stuckLabel.id);
			}

			await this.endRun(claim, job, run, 'the PR is up');

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
			const pullRequest = await this.options.findPullRequest(run.githubRepo, run.branch);

			if (pullRequest?.state !== 'MERGED' && pullRequest?.state !== 'CLOSED') {
				return;
			}
		}

		this.options.send({ type: 'cleanup', job, run });
	}

	private async flagRun(claim: Claim, run: Run, agent: Agent, status: 'awaitingInput' | 'error') {
		this.options.log(`${claim.identifier}: agent ${agent.status} without a PR; flagging it as ${status}`);
		await this.flag(claim, runComment(this.options.config, status, claim, agent, run, this.options.now()));
		await this.options.claims.put({ ...claim, status });
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

const codeBlock = (text: string) => `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;

type Agent = NonNullable<Claim['agent']>;

function describeStop(agent: Agent, now: number) {
	const minutes = Math.round((now - agent.since) / 60_000);

	switch (agent.status) {
		case 'idle':
			return `has been idle for ${minutes} min`;
		case 'done':
			return `finished its turn ${minutes} min ago`;
		case 'blocked':
			return `has been waiting for input for ${minutes} min`;
		case 'exited':
			return 'exited';
		case 'vanished':
			return 'disappeared (its tab was closed or herdr restarted)';
		default:
			return 'stopped';
	}
}

function runComment(config: Config, status: 'awaitingInput' | 'error', claim: Claim, agent: Agent, run: Run, now: number) {
	const next =
		status === 'awaitingInput'
			? `Answer the agent in its tab and it carries on, or remove the label and move the epic back to ${config.states.ready} to start over.`
			: `Remove the label and move the epic back to ${config.states.ready} to start over.`;

	return [
		`**herdr-linear** (\`${status}\`): the agent ${describeStop(agent, now)} without opening a PR.`,
		'',
		`- Tab: \`${claim.job?.tabLabel}\` (${run.tabId}), pane ${run.paneId}`,
		`- Worktree: \`${run.worktreePath}\` on branch \`${run.branch}\``,
		'',
		'Last lines of the pane:',
		'',
		codeBlock(agent.tail),
		'',
		`The epic stays in ${config.states.implementing} with the \`${config.labels.stuck}\` label. ${next}`,
	].join('\n');
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
