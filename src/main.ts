import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ClaimStore } from './claims.ts';
import { loadConfig } from './config.ts';
import { Dispatcher } from './dispatcher.ts';
import { findPullRequest } from './github.ts';
import { Herdr } from './herdr.ts';
import { LinearClient } from './linear.ts';
import { dispatcherMessageSchema, workerMessageSchema } from './protocol.ts';
import { Worker } from './worker.ts';

const envSchema = z.object({
	HERDR_BIN_PATH: z.string().min(1),
	HERDR_SOCKET_PATH: z.string().min(1),
	HERDR_PLUGIN_CONFIG_DIR: z.string().min(1),
	HERDR_PLUGIN_STATE_DIR: z.string().min(1),
	HERDR_LINEAR_KEY_FILE: z.string().min(1).default(join(homedir(), '.config/herdr-linear/linear-key')),
	CLAUDE_CONFIG_PATH: z.string().min(1).default(join(homedir(), '.claude.json')),
});

const env = envSchema.parse(process.env);
const config = await loadConfig(join(env.HERDR_PLUGIN_CONFIG_DIR, 'config.json'));

async function readApiKey(path: string) {
	const { mode } = await stat(path).catch((error: NodeJS.ErrnoException) => {
		throw error.code === 'ENOENT' ? new Error(`no Linear API key: create ${path} with mode 600`) : error;
	});

	if (mode & 0o077) {
		throw new Error(`${path} is readable by other users; run chmod 600 ${path}`);
	}

	const key = (await readFile(path, 'utf8')).trim();

	if (!key) {
		throw new Error(`${path} is empty`);
	}

	return key;
}

const log = (line: string) => console.log(line);
const pausedPath = join(env.HERDR_PLUGIN_STATE_DIR, 'paused');

const worker: Worker = new Worker({
	herdr: new Herdr(env.HERDR_BIN_PATH, env.HERDR_SOCKET_PATH),
	worktreesDirectory: config.worktreesDirectory,
	workspaceLabel: config.workspaceLabel,
	claudeConfigPath: env.CLAUDE_CONFIG_PATH,
	reconcileMs: config.pollSeconds * 1000,
	// Both sides validate what they receive, as they will once a remote worker sits behind a WebSocket.
	send: (message) => void dispatcher.handle(workerMessageSchema.parse(message)),
	log: (line) => log(`worker: ${line}`),
});

const dispatcher: Dispatcher = new Dispatcher({
	config,
	linear: new LinearClient({ apiKey: await readApiKey(env.HERDR_LINEAR_KEY_FILE) }),
	claims: await ClaimStore.open(join(env.HERDR_PLUGIN_STATE_DIR, 'claims.json')),
	send: (message) => queueMicrotask(() => void worker.handle(dispatcherMessageSchema.parse(message))),
	findPullRequest,
	isPaused: () => access(pausedPath).then(
		() => true,
		() => false,
	),
	now: Date.now,
	log,
});

log(`watching ${Object.keys(config.teams).join(', ')} every ${config.pollSeconds}s, at most ${config.maxInFlight} in flight`);
worker.start();
dispatcher.start();
void dispatcher.tick();
setInterval(() => void dispatcher.tick(), config.pollSeconds * 1000);
