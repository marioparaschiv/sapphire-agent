import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TranscriptSession = { readonly id: string; readonly cwd: string };

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

const assistant = (session: TranscriptSession, content: ReadonlyArray<Entry>, stopReason: string): Entry => ({
	...common(session),
	type: 'assistant',
	message: { model: 'claude-opus-5-5', id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, stop_reason: stopReason },
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

	text: (session: TranscriptSession, text: string) => [assistant(session, [{ type: 'text', text }], 'end_turn')],

	// The SendMessage call and its result.
	sentMessage: (session: TranscriptSession, to: string, message: string) => {
		const toolUseId = `toolu_${randomUUID()}`;
		const result = `“Question” → ${to} (another Claude session on this machine; in that session's inbox, not yet read by its Claude)`;

		return [
			assistant(session, [{ type: 'tool_use', id: toolUseId, name: 'SendMessage', input: { to, summary: 'Question', message, type: 'message', recipient: to, content: message } }], 'tool_use'),
			user(session, [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success: true, message: result, msg_id: randomUUID() }) }] }]),
			{ ...common(session), type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '<total_tokens>14989386 tokens left</total_tokens>' } },
		];
	},

	// A message another session sent, which wakes the agent.
	peerMessage: (session: TranscriptSession, from: string, body: string) => [
		user(
			session,
			`Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/701639.sock" from-name="${from}" from-mode="bypass">\n${body}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.`,
			{ isMeta: true, origin: { kind: 'peer', name: from, body }, turnOrigin: 'peer' },
		),
	],

	// A background task finished, which wakes the agent too.
	taskNotification: (session: TranscriptSession) => [
		user(session, '<task-notification>\n<task-id>a650bf78e369bd15</task-id>\n<status>completed</status>\n<summary>Agent "Review the sync module" completed</summary>\n</task-notification>'),
	],
};

// Claude Code's directory name for a cwd. Past 200 characters it appends a hash of its own, which this one only stands in for.
const projectDirectory = (cwd: string) => {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');

	return slug.length <= 200 ? slug : `${slug.slice(0, 200)}-${createHash('sha256').update(cwd).digest('hex').slice(0, 7)}`;
};

// Writes the session's transcript where Claude Code does.
export const writeTranscript = (claudeConfigDirectory: string, session: TranscriptSession, entries: ReadonlyArray<Entry>) => {
	const directory = join(claudeConfigDirectory, 'projects', projectDirectory(session.cwd));

	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, `${session.id}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
};
