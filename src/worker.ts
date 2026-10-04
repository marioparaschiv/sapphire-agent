import { githubRepo, prepareWorktree, worktreePath } from './git.ts';
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

type Tracked = { run: Run; status?: AgentStatus; unsubscribe?: () => void };

const TAIL_LINES = 40;
const START_TIMEOUT_MS = 30_000;

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

		try {
			if (message.type === 'dispatch') {
				await this.dispatch(job);
			} else if (message.run) {
				this.track(job.epicId, message.run);
			} else {
				await this.adopt(job);
			}
		} catch (error) {
			this.options.send({
				type: 'failed',
				epicId: job.epicId,
				error: error instanceof Error ? error.message : String(error),
				tail: error instanceof StartError ? error.tail : undefined,
			});
		}
	}

	private async dispatch(job: Job) {
		const { herdr, worktreesDirectory, claudeConfigPath, send, log } = this.options;
		const path = await prepareWorktree(job.repoPath, job.branch, worktreesDirectory);
		const repo = await githubRepo(job.repoPath);

		await trustFolder(claudeConfigPath, path);

		const { tabId, paneId } = await this.openTab(job.tabLabel, path);

		log(`${job.identifier}: starting Claude in ${tabId} (${path})`);

		try {
			await herdr.startAgent(job.identifier.toLowerCase(), paneId, job.prompt, START_TIMEOUT_MS);
		} catch (error) {
			if (!(error instanceof HerdrError && error.code === 'timeout')) {
				throw new StartError(error instanceof Error ? error.message : String(error), await herdr.readPane(paneId, TAIL_LINES));
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

	private track(epicId: string, run: Run) {
		this.runs.get(epicId)?.unsubscribe?.();
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
				this.options.log(`reconciling ${epicId} failed: ${error instanceof Error ? error.message : String(error)}`);
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
			tracked.unsubscribe?.();
			this.runs.delete(epicId);
			send({
				type: 'finished',
				epicId,
				reason: pane ? 'exited' : 'vanished',
				tail: pane ? await herdr.readPane(paneId, TAIL_LINES) : '',
			});

			return;
		}

		if (agent.agent_status === tracked.status) {
			return;
		}

		tracked.status = agent.agent_status;
		const tail = agent.agent_status === 'working' ? '' : await herdr.readPane(paneId, TAIL_LINES);

		send({ type: 'status', epicId, status: agent.agent_status, tail });
	}
}
