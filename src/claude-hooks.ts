import { Effect, Option, Schema } from 'effect';
import { type AgentAdapter, type AgentEvent, SessionSource } from './agent-event.ts';

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

// The PreToolUse answer that refuses the tool call; Claude reads `reason`.
export const denyToolUse = (reason: string) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// The PreToolUse answer that runs the tool call without asking the user, as a supervised session otherwise would.
export const allowToolUse = (reason: string) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } });

const toEvent = (payload: ClaudeHook): Option.Option<AgentEvent> => {
	const { sessionId, cwd } = payload;

	// A subagent's events only show it is working, but for its tool calls, which check its context.
	if (payload.agentId !== undefined) {
		return Option.some({ _tag: payload.hookEventName === 'PostToolUse' ? 'ToolUsed' : 'Acted', sessionId, cwd, agentId: payload.agentId });
	}

	switch (payload.hookEventName) {
		case 'PreToolUse':
		case 'SubagentStop':
			return Option.some({ _tag: 'Acted', sessionId, cwd, agentId: null });
		case 'SessionStart':
			return Option.some({ _tag: 'SessionStarted', sessionId, cwd, source: payload.source });
		case 'UserPromptSubmit':
			return Option.some({ _tag: 'TurnStarted', sessionId, cwd });
		case 'Stop':
			return Option.some({ _tag: 'TurnEnded', sessionId, cwd });
		case 'Notification':
			return Option.some({ _tag: 'Notified', sessionId, cwd });
		case 'SessionEnd':
			return Option.some({ _tag: 'SessionEnded', sessionId, cwd });
		case 'PostToolUse':
			return Option.some({ _tag: 'ToolUsed', sessionId, cwd, agentId: null });
	}
};

export const claudeAdapter: AgentAdapter = {
	decode: (payload) => Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeHook))(payload).pipe(Effect.map(toEvent)),
	toolContext: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
};
