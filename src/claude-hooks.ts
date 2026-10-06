import { Effect, Option, Schema } from 'effect';
import { type AgentAdapter, type AgentEvent, SessionSource } from './agent-event.ts';

const keys = { hookEventName: 'hook_event_name', sessionId: 'session_id', agentId: 'agent_id', toolName: 'tool_name', toolInput: 'tool_input' } as const;

// Every hook payload has these; `agent_id` only when a subagent fires it.
const hook = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) =>
	Schema.Struct({ hookEventName: Schema.Literal(name), sessionId: Schema.String, agentId: Schema.optional(Schema.String), ...fields }).pipe(Schema.encodeKeys(keys));

// The hooks `~/.claude/settings.json` runs `sapphire hook claude` for.
const ClaudeHook = Schema.Union([
	hook('SessionStart', { source: SessionSource }),
	hook('UserPromptSubmit', {}),
	hook('Stop', {}),
	hook('Notification', { message: Schema.String }),
	hook('SessionEnd', { reason: Schema.String }),
	hook('PostToolUse', { toolName: Schema.Literal('Skill'), toolInput: Schema.Struct({ skill: Schema.String }) }),
	hook('PostToolUse', { toolName: Schema.String }),
]);

type ClaudeHook = typeof ClaudeHook.Type;

const toEvent = (payload: ClaudeHook): Option.Option<AgentEvent> => {
	if (payload.agentId !== undefined) {
		return payload.hookEventName === 'PostToolUse' ? Option.some({ _tag: 'ToolUsed', sessionId: payload.sessionId, agentId: payload.agentId }) : Option.none();
	}

	switch (payload.hookEventName) {
		case 'SessionStart':
			return Option.some({ _tag: 'SessionStarted', sessionId: payload.sessionId, source: payload.source });
		case 'UserPromptSubmit':
			return Option.some({ _tag: 'TurnStarted', sessionId: payload.sessionId });
		case 'Stop':
			return Option.some({ _tag: 'TurnEnded', sessionId: payload.sessionId });
		case 'Notification':
			return Option.some({ _tag: 'Notified', sessionId: payload.sessionId, message: payload.message });
		case 'SessionEnd':
			return Option.some({ _tag: 'SessionEnded', sessionId: payload.sessionId, reason: payload.reason });
		case 'PostToolUse':
			return Option.some(
				'toolInput' in payload
					? // A plugin's skill is reported as `<plugin>:<skill>`.
						{ _tag: 'SkillInvoked', sessionId: payload.sessionId, skill: payload.toolInput.skill.slice(payload.toolInput.skill.lastIndexOf(':') + 1) }
					: { _tag: 'ToolUsed', sessionId: payload.sessionId, agentId: null },
			);
	}
};

export const claudeAdapter: AgentAdapter = {
	decode: (payload) => Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeHook))(payload).pipe(Effect.map(toEvent)),
	toolContext: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
};
