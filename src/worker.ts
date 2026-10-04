import { rm } from 'node:fs/promises';
import { githubRepo, prepareWorktree, readResultFile, removeWorktree, resultFilePath, unsavedWork, worktreePath } from './git.ts';
import { type Herdr, HerdrError } from './herdr.ts';
import type { AgentStatus, DispatcherMessage, Job, Run, Send, WorkerMessage } from './protocol.ts';
import { trustFolder } from './trust.ts';

export type WorkerOptions = {
	herdr: Herdr;
	worktreesDirectory: string;
	workspaceLabel: string;
	claudeConfigPath: string;
	reconcileMs: number;
	send: Send<WorkerMessage>;
	log: (line: string) => void;
};

type Tracked = { run: Run; status?: AgentStatus; tail?: string; resultReported?: boolean; unsubscribe?: () => void };

const TAIL_LINES = 40;
const START_TIMEOUT_MS = 30_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

class StartError extends Error {
	readonly tail?: string;

	constructor(message: string, tail?: string) {
		super(message);
		this.tail = tail;
	}
}

// Runs Claude Code for an epic in a herdr tab and reports what the agent does. It never talks to Linear.
export class Worker {
	private readonly options: WorkerOptions;
	private readonly runs = new Map<string, Tracked>();
	private timer: NodeJS.Timeout | undefined;
	private reconciling = Promise.resolve();
	private queue = Promise.resolve();

	constructor(options: WorkerOptions) {
		this.options = options;
	}

	// herdr events are not durable, so every run is also re-read on a timer.
	start() {
		this.timer = setInterval(() => {
			for (const epicId of this.runs.keys()) {
				void this.reconcile(epicId);
			}
		}, this.options.reconcileMs);
	}

	stop() {
		clearInterval(this.timer);

		for (const tracked of this.runs.values()) {
			tracked.unsubscribe?.();
		}
	}

	async handle(message: DispatcherMessage) {
		const { job } = message;

		switch (message.type) {
			case 'dispatch':
				return this.startRun(job, () => this.dispatch(job));

			case 'watch':
				return message.run ? this.track(job.epicId, message.run) : this.startRun(job, () => this.adopt(job));

			case 'close':
				return this.closeRun(job, message.run).catch((error: unknown) => this.logError(`closing ${job.identifier}'s tab`, error));

			case 'cleanup':
				return this.serial(() => this.cleanup(job, message.run)).catch((error: unknown) =>
					this.logError(`cleaning up ${job.identifier}`, error),
				);

			case 'nudge':
				return this.nudge(job, message.run).catch((error: unknown) => this.logError(`nudging ${job.identifier}`, error));

			case 'reply':
				return this.options.herdr.prompt(message.run.paneId, message.text).then(
					() => this.options.log(`${job.identifier}: typed reply ${message.commentId} into ${message.run.paneId}`),
					(error: unknown) =>
						this.options.send({ type: 'replyFailed', epicId: job.epicId, commentId: message.commentId, error: errorMessage(error) }),
				);
		}
	}

	private async startRun(job: Job, start: () => Promise<void>) {
		try {
			await this.serial(start);
		} catch (error) {
			this.options.send({
				type: 'failed',
				epicId: job.epicId,
				error: errorMessage(error),
				tail: error instanceof StartError ? error.tail : undefined,
			});
		}
	}

	private logError(action: string, error: unknown) {
		this.options.log(`${action} failed: ${errorMessage(error)}`);
	}

	// Starts and cleanups run one at a time: concurrent starts would race on ~/.claude.json and on creating the
	// workspace, and git worktree commands on one repo would race on its lock files.
	private serial(task: () => Promise<void>) {
		const result = this.queue.then(task);
		this.queue = result.catch(() => {});

		return result;
	}

	private async dispatch(job: Job) {
		const { herdr, worktreesDirectory, claudeConfigPath, send, log } = this.options;
		const path = await prepareWorktree(job.repoPath, job.branch, worktreesDirectory);
		const repo = await githubRepo(job.repoPath);

		// A reused worktree may still hold the result of an earlier run.
		await rm(await resultFilePath(path), { force: true });

		await trustFolder(claudeConfigPath, path);

		const { tabId, paneId } = await this.openTab(job.tabLabel, path);

		log(`${job.identifier}: starting Claude in ${tabId} (${path})`);

		try {
			await herdr.startAgent(job.identifier.toLowerCase(), paneId, job.prompt, START_TIMEOUT_MS);
		} catch (error) {
			if (!(error instanceof HerdrError && error.code === 'timeout')) {
				throw new StartError(errorMessage(error), await herdr.readPane(paneId, TAIL_LINES));
			}
		}

		const agent = await herdr.agent(paneId);

		if (agent?.agent !== 'claude' || agent.agent_status === 'blocked') {
			const state = agent?.agent ? `${agent.agent} is ${agent.agent_status}` : 'no agent is running';

			throw new StartError(`Claude did not start in ${tabId}: ${state}`, await herdr.readPane(paneId, TAIL_LINES));
		}

		const run: Run = { tabId, paneId, worktreePath: path, branch: job.branch, githubRepo: repo };

		send({ type: 'started', epicId: job.epicId, run });
		this.track(job.epicId, run);
	}

	private async openTab(label: string, cwd: string) {
		const { herdr, workspaceLabel } = this.options;
		const workspace = (await herdr.workspaces()).find((candidate) => candidate.label === workspaceLabel);

		if (workspace) {
			const { tab, root_pane } = await herdr.createTab(workspace.workspace_id, label, cwd);

			return { tabId: tab.tab_id, paneId: root_pane.pane_id };
		}

		const { tab, root_pane } = await herdr.createWorkspace(workspaceLabel, cwd);
		await herdr.renameTab(tab.tab_id, label);

		return { tabId: tab.tab_id, paneId: root_pane.pane_id };
	}

	// The dispatcher restarted between sending a dispatch and hearing back: look for the job's tab.
	private async adopt(job: Job) {
		const { herdr, workspaceLabel, worktreesDirectory } = this.options;
		const workspace = (await herdr.workspaces()).find((candidate) => candidate.label === workspaceLabel);
		const tab = workspace && (await herdr.tabs(workspace.workspace_id)).find((candidate) => candidate.label === job.tabLabel);
		const pane = tab && workspace && (await herdr.panes(workspace.workspace_id)).find((candidate) => candidate.tab_id === tab.tab_id);
		const agent = pane && (await herdr.agent(pane.pane_id));

		if (!tab || !pane || agent?.agent !== 'claude') {
			throw new StartError('the dispatch was interrupted before the agent was confirmed running');
		}

		const run: Run = {
			tabId: tab.tab_id,
			paneId: pane.pane_id,
			worktreePath: worktreePath(worktreesDirectory, job.repoPath, job.branch),
			branch: job.branch,
			githubRepo: await githubRepo(job.repoPath),
		};

		this.options.send({ type: 'started', epicId: job.epicId, run });
		this.track(job.epicId, run);
	}

	// Only closes the tab it opened: after a herdr restart the same id can belong to another tab.
	private async closeRun(job: Job, run: Run) {
		const { herdr, log } = this.options;

		this.untrack(job.epicId);

		const tab = await herdr.tab(run.tabId);

		if (tab?.label !== job.tabLabel) {
			return;
		}

		await herdr.closeTab(run.tabId);
		log(`${job.identifier}: closed tab ${run.tabId}`);
	}

	private async nudge(job: Job, run: Run) {
		const { herdr, log } = this.options;

		await herdr.sendKeys(run.paneId, ['esc']);
		await herdr.prompt(run.paneId, 'continue');
		log(`${job.identifier}: nudged ${run.paneId}`);
	}

	private async cleanup(job: Job, run: Run) {
		const { send, log } = this.options;

		await this.closeRun(job, run);

		const reason = await unsavedWork(job.repoPath, job.branch, run.worktreePath);

		if (reason) {
			send({ type: 'kept', epicId: job.epicId, worktreePath: run.worktreePath, reason });

			return;
		}

		await removeWorktree(job.repoPath, job.branch, run.worktreePath);
		log(`${job.identifier}: removed ${run.worktreePath} and branch ${job.branch}`);
		send({ type: 'cleaned', epicId: job.epicId });
	}

	private untrack(epicId: string) {
		this.runs.get(epicId)?.unsubscribe?.();
		this.runs.delete(epicId);
	}

	private track(epicId: string, run: Run) {
		this.untrack(epicId);
		this.runs.set(epicId, { run });
		this.subscribe(epicId);
		void this.reconcile(epicId);
	}

	private subscribe(epicId: string) {
		const tracked = this.runs.get(epicId);

		if (!tracked) {
			return;
		}

		tracked.unsubscribe = this.options.herdr.subscribe(
			tracked.run.paneId,
			() => void this.reconcile(epicId),
			(error) => {
				if (this.runs.get(epicId) !== tracked) {
					return;
				}

				this.options.log(`event stream for ${tracked.run.paneId} closed${error ? `: ${error}` : ''}; reconnecting`);
				setTimeout(() => this.runs.get(epicId) === tracked && this.subscribe(epicId), this.options.reconcileMs);
			},
		);
	}

	// Reads the agent's real state and reports changes. Calls run one at a time so a burst of events cannot
	// report the same change twice.
	private reconcile(epicId: string) {
		this.reconciling = this.reconciling
			.then(() => this.reconcileNow(epicId))
			.catch((error: unknown) => {
				this.logError(`reconciling ${epicId}`, error);
			});

		return this.reconciling;
	}

	private async reconcileNow(epicId: string) {
		const { herdr, send } = this.options;
		const tracked = this.runs.get(epicId);

		if (!tracked) {
			return;
		}

		const { paneId } = tracked.run;
		const pane = await herdr.pane(paneId);
		const agent = pane && (await herdr.agent(paneId));

		if (!pane || agent?.agent !== 'claude') {
			this.untrack(epicId);
			await this.reportResult(epicId, tracked);
			send({
				type: 'finished',
				epicId,
				reason: pane ? 'exited' : 'vanished',
				tail: pane ? await herdr.readPane(paneId, TAIL_LINES) : '',
			});

			return;
		}

		// The tail is sent while working too: the dispatcher tells a hung agent by its tail not changing.
		const tail = await herdr.readPane(paneId, TAIL_LINES);

		if (agent.agent_status !== tracked.status || tail !== tracked.tail) {
			tracked.status = agent.agent_status;
			tracked.tail = tail;
			send({ type: 'status', epicId, status: agent.agent_status, tail });
		}

		// The agent writes the file as its last step, so it is only read once the agent stops; never half-written.
		if (agent.agent_status !== 'working') {
			await this.reportResult(epicId, tracked);
		}
	}

	private async reportResult(epicId: string, tracked: Tracked) {
		if (tracked.resultReported) {
			return;
		}

		const read = await readResultFile(tracked.run.worktreePath);

		if (!read) {
			return;
		}

		tracked.resultReported = true;
		this.options.send(
			read.ok ? { type: 'result', epicId, result: read.result } : { type: 'invalidResult', epicId, error: read.error },
		);
	}
}
