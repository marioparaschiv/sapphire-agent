import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { maxSlugLength, projectSlug, type TranscriptSession } from './claude-transcript.ts';

type Entry = Record<string, unknown>;

// What Claude Code 2.1 writes on every entry, trimmed.
const common = (session: TranscriptSession) => ({
	isSidechain: false,
	uuid: randomUUID(),
	timestamp: '2026-10-05T02:55:26.376Z',
	userType: 'external',
	entrypoint: 'cli',
	cwd: session.cwd,
	sessionId: session.id,
	version: '2.1.289',
});

// What Claude Code records of the request behind an assistant entry, with most of the context read from the prompt cache.
const usage = (context: number) => ({
	input_tokens: 6,
	cache_creation_input_tokens: 1_850,
	cache_read_input_tokens: context - 1_856,
	output_tokens: 412,
	server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
	service_tier: 'standard',
});

const assistant = (session: TranscriptSession, content: ReadonlyArray<Entry>, stopReason: string, context = 24_000): Entry => ({
	...common(session),
	type: 'assistant',
	message: { model: 'claude-opus-5-5', id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, stop_reason: stopReason, usage: usage(context) },
});

const user = (session: TranscriptSession, content: string | ReadonlyArray<Entry>, extra: Entry = {}): Entry => ({
	...common(session),
	type: 'user',
	message: { role: 'user', content },
	...extra,
});

// Entries of a Claude session's transcript, as recorded from real sessions.
export const transcriptEntries = {
	prompt: (session: TranscriptSession, text: string) => [user(session, text, { permissionMode: 'bypassPermissions' })],

	// A Bash call and its result, made with `context` tokens in the model's context.
	toolCall: (session: TranscriptSession, context: number) => {
		const toolUseId = `toolu_${randomUUID()}`;

		return [
			assistant(session, [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }], 'tool_use', context),
			user(session, [{ tool_use_id: toolUseId, type: 'tool_result', content: 'Tests  271 passed (271)', is_error: false }]),
		];
	},
};

// Claude Code's directory name for a cwd. When shortened it appends a hash of its own, which this one only stands in for.
const projectDirectory = (cwd: string) => {
	const slug = projectSlug(cwd);

	return slug.length <= maxSlugLength ? slug : `${slug.slice(0, maxSlugLength)}-${createHash('sha256').update(cwd).digest('hex').slice(0, 7)}`;
};

export const transcriptLines = (entries: ReadonlyArray<Entry>) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

// Writes the transcript of the session, or of its subagent `agentId`, where Claude Code does, and returns its path.
export const writeTranscript = (claudeConfigDirectory: string, session: TranscriptSession, entries: ReadonlyArray<Entry>, agentId: string | null = null) => {
	const directory = join(claudeConfigDirectory, 'projects', projectDirectory(session.cwd));
	const path = agentId === null ? join(directory, `${session.id}.jsonl`) : join(directory, session.id, 'subagents', `agent-${agentId}.jsonl`);

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, transcriptLines(entries));

	return path;
};
