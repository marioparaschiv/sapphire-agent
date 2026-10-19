import { homedir } from 'node:os';
import { Effect, Option, Schema } from 'effect';
import type { AgentAdapter, AgentEvent } from './agent-event.ts';
import type { ToolCall } from './run-guards.ts';

// The T3 thread a Pi session runs in, as T3 tells it (`pi-extension.ts`). A delegated task's child runs in its own
// thread, a `subagent` of the thread that delegated it, in the same checkout.
export const PiThread = Schema.Struct({
	threadId: Schema.String,
	parentThreadId: Schema.NullOr(Schema.String),
	relationshipToParent: Schema.NullOr(Schema.Literals(['fork', 'subagent'])),
});

export type PiThread = typeof PiThread.Type;

// Every payload has these. `thread` is null outside T3, or while T3 could not tell; `contextTokens` is Pi's estimate of
// the context, null while it cannot tell.
const hook = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) =>
	Schema.Struct({ event: Schema.Literal(name), sessionId: Schema.String, cwd: Schema.String, thread: Schema.NullOr(PiThread), ...fields });

const SessionStartReason = Schema.Literals(['startup', 'reload', 'new', 'resume', 'fork']);

const contextTokens = Schema.NullOr(Schema.Int);

// The Pi events the extension sends, by their Pi names.
export const PiHook = Schema.Union([
	hook('session_start', { reason: SessionStartReason }),
	hook('before_agent_start', {}),
	hook('tool_call', { toolName: Schema.String }),
	hook('tool_result', { toolName: Schema.String, contextTokens }),
	hook('agent_end', { contextTokens }),
	hook('agent_settled', {}),
	hook('session_shutdown', {}),
]);

export type PiHook = typeof PiHook.Type;

// `reload` reloads the extensions of the same session; `new` replaces it with an empty one in the same process.
const sources = { startup: 'startup', reload: 'resume', new: 'clear', resume: 'resume', fork: 'fork' } as const;

const toEvent = (payload: PiHook): Option.Option<AgentEvent> => {
	const { sessionId, cwd, thread } = payload;

	if (thread === null) {
		return Option.none();
	}

	// A subagent's events, under its parent's thread, only show it is working, but for its tool calls, which check its
	// context. Its thread names it as Claude's `agent_id` does.
	if (thread.relationshipToParent === 'subagent' && thread.parentThreadId !== null) {
		const subagent = { sessionId, cwd, threadId: thread.parentThreadId, agentId: thread.threadId };

		return Option.some(payload.event === 'tool_result' ? { _tag: 'ToolUsed', ...subagent, contextTokens: payload.contextTokens } : { _tag: 'Acted', ...subagent });
	}

	const own = { sessionId, cwd, threadId: thread.threadId };

	switch (payload.event) {
		case 'session_start':
			return Option.some({ _tag: 'SessionStarted', ...own, source: sources[payload.reason] });
		case 'before_agent_start':
			return Option.some({ _tag: 'TurnStarted', ...own });
		case 'tool_call':
			return Option.some({ _tag: 'Acted', ...own, agentId: null });
		case 'tool_result':
			return Option.some({ _tag: 'ToolUsed', ...own, agentId: null, contextTokens: payload.contextTokens });
		case 'agent_end':
			return Option.some({ _tag: 'TurnEnded', ...own, contextTokens: payload.contextTokens });
		// Pi will not go on by itself (no retry, compaction or queued message), so it waits for input.
		case 'agent_settled':
			return Option.some({ _tag: 'Notified', ...own });
		case 'session_shutdown':
			return Option.some({ _tag: 'SessionEnded', ...own });
	}
};

export const piAdapter: AgentAdapter = {
	decode: (payload) => Schema.decodeUnknownEffect(Schema.fromJsonString(PiHook))(payload).pipe(Effect.map(toEvent)),
	// The extension adds it to the tool's result as it is.
	toolContext: (text) => text,
};

// The tools a command's agent may use in full (`run-guards.ts`).
const readTools = ['read', 'grep', 'find', 'ls'];

// A path as Pi's tools resolve it: without a leading `@`, `~` for the home directory.
const toolPath = (path: string) => path.replace(/^@/, '').replace(/^~(?=\/|$)/, homedir());

export const piToolCall = (name: string, input: Readonly<Record<string, unknown>>): ToolCall => {
	if (name === 'bash' && typeof input.command === 'string') {
		return { _tag: 'Shell', name, command: input.command };
	}

	if ((name === 'edit' || name === 'write') && typeof input.path === 'string') {
		return { _tag: 'FileWrite', name, path: toolPath(input.path) };
	}

	return readTools.includes(name) ? { _tag: 'Read', name } : { _tag: 'Other', name };
};
