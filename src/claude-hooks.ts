import { Effect, Option, Schema } from 'effect';
import { type AgentAdapter, type AgentEvent, SessionSource } from './agent-event.ts';
import type { ToolCall } from './run-guards.ts';

const keys = { hookEventName: 'hook_event_name', sessionId: 'session_id', agentId: 'agent_id', toolName: 'tool_name', toolInput: 'tool_input' } as const;

// Every hook payload has these; `agent_id` only when a subagent fires it.
const hook = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) =>
	Schema.Struct({ hookEventName: Schema.Literal(name), sessionId: Schema.String, cwd: Schema.String, agentId: Schema.optional(Schema.String), ...fields }).pipe(Schema.encodeKeys(keys));

// The hooks `~/.claude/settings.json` runs `sapphire hook claude` for.
const ClaudeHook = Schema.Union([
	hook('SessionStart', { source: SessionSource }),
	hook('UserPromptSubmit', {}),
	hook('Stop', {}),
	hook('Notification', {}),
	hook('SessionEnd', {}),
	hook('PostToolUse', { toolName: Schema.String }),
	hook('PreToolUse', { toolName: Schema.String }),
	hook('SubagentStop', {}),
]);

type ClaudeHook = typeof ClaudeHook.Type;

const FilePathInput = Schema.Struct({ filePath: Schema.String }).pipe(Schema.encodeKeys({ filePath: 'file_path' }));

const NotebookPathInput = Schema.Struct({ notebookPath: Schema.String }).pipe(Schema.encodeKeys({ notebookPath: 'notebook_path' }));

// The tool calls the hook process guards itself (`run-hooks.ts`).
export const ClaudeRunHook = Schema.Union([
	hook('PreToolUse', { toolName: Schema.Literal('Bash'), toolInput: Schema.Struct({ command: Schema.String }) }),
	hook('PreToolUse', { toolName: Schema.Literals(['Write', 'Edit', 'MultiEdit']), toolInput: FilePathInput }),
	hook('PreToolUse', { toolName: Schema.Literal('NotebookEdit'), toolInput: NotebookPathInput }),
	hook('PreToolUse', { toolName: Schema.String }),
]);

export type ClaudeRunHook = typeof ClaudeRunHook.Type;

// The tools a command's agent may use in full (`run-guards.ts`).
const readTools = ['Read', 'Grep', 'Glob', 'SendMessage'];

export const claudeToolCall = (hook: ClaudeRunHook): ToolCall => {
	const name = hook.toolName;

	if (!('toolInput' in hook)) {
		return readTools.includes(name) ? { _tag: 'Read', name } : { _tag: 'Other', name };
	}

	if ('command' in hook.toolInput) {
		return { _tag: 'Shell', name, command: hook.toolInput.command };
	}

	return { _tag: 'FileWrite', name, path: 'filePath' in hook.toolInput ? hook.toolInput.filePath : hook.toolInput.notebookPath };
};

// The PreToolUse answer that refuses the tool call; Claude reads `reason`.
export const denyToolUse = (reason: string) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// The PreToolUse answer that runs the tool call without asking the user, as a supervised session otherwise would.
export const allowToolUse = (reason: string) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } });

const toEvent = (payload: ClaudeHook): Option.Option<AgentEvent> => {
	// Claude knows no T3 thread, so its events are tied to a run by the directory it works in.
	const { sessionId, cwd } = payload;
	const threadId = null;

	// A subagent's events only show it is working, but for its tool calls, which check its context.
	if (payload.agentId !== undefined) {
		return Option.some({ _tag: payload.hookEventName === 'PostToolUse' ? 'ToolUsed' : 'Acted', sessionId, cwd, threadId, agentId: payload.agentId });
	}

	switch (payload.hookEventName) {
		case 'PreToolUse':
		case 'SubagentStop':
			return Option.some({ _tag: 'Acted', sessionId, cwd, threadId, agentId: null });
		case 'SessionStart':
			return Option.some({ _tag: 'SessionStarted', sessionId, cwd, threadId, source: payload.source });
		case 'UserPromptSubmit':
			return Option.some({ _tag: 'TurnStarted', sessionId, cwd, threadId });
		case 'Stop':
			return Option.some({ _tag: 'TurnEnded', sessionId, cwd, threadId });
		case 'Notification':
			return Option.some({ _tag: 'Notified', sessionId, cwd, threadId });
		case 'SessionEnd':
			return Option.some({ _tag: 'SessionEnded', sessionId, cwd, threadId });
		case 'PostToolUse':
			return Option.some({ _tag: 'ToolUsed', sessionId, cwd, threadId, agentId: null });
	}
};

export const claudeAdapter: AgentAdapter = {
	decode: (payload) => Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeHook))(payload).pipe(Effect.map(toEvent)),
	toolContext: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
};
