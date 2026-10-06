import { Effect, Option, Schema } from 'effect';
import { type AgentAdapter, type AgentEvent, SessionSource } from './agent-event.ts';

const keys = { hookEventName: 'hook_event_name', sessionId: 'session_id', agentId: 'agent_id' } as const;

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
]);

type ClaudeHook = typeof ClaudeHook.Type;

const toEvent = (payload: ClaudeHook): AgentEvent => {
	switch (payload.hookEventName) {
		case 'SessionStart':
			return { _tag: 'SessionStarted', sessionId: payload.sessionId, source: payload.source };
		case 'UserPromptSubmit':
			return { _tag: 'TurnStarted', sessionId: payload.sessionId };
		case 'Stop':
			return { _tag: 'TurnEnded', sessionId: payload.sessionId };
		case 'Notification':
			return { _tag: 'Notified', sessionId: payload.sessionId, message: payload.message };
		case 'SessionEnd':
			return { _tag: 'SessionEnded', sessionId: payload.sessionId, reason: payload.reason };
	}
};

export const decodeClaudeHook: AgentAdapter = (payload) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeHook))(payload).pipe(
		Effect.map((decoded) => (decoded.agentId === undefined ? Option.some(toEvent(decoded)) : Option.none())),
	);
