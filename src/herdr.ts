import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agentStatusSchema } from './protocol.ts';

const execFileAsync = promisify(execFile);

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const eventSchema = z.object({ event: z.string() });

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export class HerdrError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`herdr ${code}: ${message}`);
		this.code = code;
	}
}

const paneSchema = z.object({ pane_id: z.string(), tab_id: z.string(), workspace_id: z.string() });

const tabSchema = z.object({ tab_id: z.string(), label: z.string() });

const agentSchema = z.object({
	pane_id: z.string(),
	agent: z.string().nullish(),
	agent_status: agentStatusSchema,
});

export type HerdrAgent = z.infer<typeof agentSchema>;

// Wraps the herdr CLI, which every call goes through except the event stream (that needs the raw socket).
export class Herdr {
	private readonly bin: string;
	private readonly socketPath: string;

	constructor(bin: string, socketPath: string) {
		this.bin = bin;
		this.socketPath = socketPath;
	}

	private async exec(args: string[]) {
		try {
			const { stdout } = await execFileAsync(this.bin, args, { maxBuffer: 16 * 1024 * 1024 });

			return stdout;
		} catch (error) {
			const parsed = errorSchema.safeParse(parseJson((error as { stderr?: string }).stderr ?? ''));

			if (parsed.success) {
				throw new HerdrError(parsed.data.error.code, parsed.data.error.message);
			}

			throw error;
		}
	}

	private async call<T extends z.ZodType>(schema: T, args: string[]): Promise<z.infer<T>> {
		const { result } = z.object({ result: z.unknown() }).parse(JSON.parse(await this.exec(args)));

		return schema.parse(result);
	}

	async workspaces() {
		const result = await this.call(
			z.object({ workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })) }),
			['workspace', 'list'],
		);

		return result.workspaces;
	}

	// The blank env makes the pane shell skip its automatic Claude launch.
	async createWorkspace(label: string, cwd: string) {
		return this.call(
			z.object({ workspace: z.object({ workspace_id: z.string() }), tab: tabSchema, root_pane: paneSchema }),
			['workspace', 'create', '--label', label, '--cwd', cwd, '--env', 'HERDR_BLANK=1', '--no-focus'],
		);
	}

	async createTab(workspaceId: string, label: string, cwd: string) {
		return this.call(z.object({ tab: tabSchema, root_pane: paneSchema }), [
			'tab',
			'create',
			'--workspace',
			workspaceId,
			'--label',
			label,
			'--cwd',
			cwd,
			'--env',
			'HERDR_BLANK=1',
			'--no-focus',
		]);
	}

	async renameTab(tabId: string, label: string) {
		await this.exec(['tab', 'rename', tabId, label]);
	}

	async tabs(workspaceId: string) {
		return (await this.call(z.object({ tabs: z.array(tabSchema) }), ['tab', 'list', '--workspace', workspaceId])).tabs;
	}

	async panes(workspaceId: string) {
		return (await this.call(z.object({ panes: z.array(paneSchema) }), ['pane', 'list', '--workspace', workspaceId]))
			.panes;
	}

	async pane(paneId: string) {
		try {
			return (await this.call(z.object({ pane: paneSchema }), ['pane', 'get', paneId])).pane;
		} catch (error) {
			if (error instanceof HerdrError && error.code === 'pane_not_found') {
				return undefined;
			}

			throw error;
		}
	}

	async agent(paneId: string) {
		try {
			return (await this.call(z.object({ agent: agentSchema }), ['agent', 'get', paneId])).agent;
		} catch (error) {
			if (error instanceof HerdrError && (error.code === 'agent_not_found' || error.code === 'pane_not_found')) {
				return undefined;
			}

			throw error;
		}
	}

	// Resolves once herdr sees the agent ready for input, which with an initial prompt only happens when that
	// prompt's turn ends; callers treat a timeout as "still starting" and confirm with agent().
	async startAgent(name: string, paneId: string, prompt: string, timeoutMs: number) {
		await this.exec(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', String(timeoutMs), '--', prompt]);
	}

	// Runs of blank lines are squeezed to one; a TUI pads its screen with them.
	async readPane(paneId: string, lines: number) {
		const text = await this.exec(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)]);

		return text
			.split('\n')
			.map((line) => line.trimEnd())
			.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
			.join('\n')
			.trim();
	}

	// Pushes every agent status change for the pane until the socket closes. Events are not durable, so
	// consumers still need authoritative reads; this only makes them prompt.
	subscribe(paneId: string, onEvent: () => void, onClose: (error?: string) => void) {
		const socket = connect(this.socketPath);
		let buffer = '';
		let closeReason: string | undefined;

		socket.on('connect', () => {
			const subscriptions = ['pane.agent_status_changed', 'pane.agent_detected', 'pane.exited', 'pane.closed'].map(
				(type) => ({ type, pane_id: paneId }),
			);
			socket.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } })}\n`);
		});

		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines.filter(Boolean)) {
				const message = parseJson(line);
				const error = errorSchema.safeParse(message);

				if (error.success) {
					closeReason = `${error.data.error.code}: ${error.data.error.message}`;
					socket.destroy();

					return;
				}

				if (eventSchema.safeParse(message).success) {
					onEvent();
				}
			}
		});

		socket.on('error', (error) => {
			closeReason = error.message;
		});

		socket.on('close', () => onClose(closeReason));

		return () => socket.destroy();
	}
}
