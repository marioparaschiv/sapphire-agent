import { type Effect, type Option, Schema } from 'effect';

// How a session came to start: a new one, one resumed, a fresh one after a clear, the same one after a compaction, or
// a fork of another.
export const SessionSource = Schema.Literals(['startup', 'resume', 'clear', 'compact', 'fork']);

// What a coding agent reports about its session, whichever agent it is. Each agent has an adapter that turns its own
// hook payload into one of these.
export const AgentEvent = Schema.TaggedUnion({
	SessionStarted: { sessionId: Schema.String, source: SessionSource },
	TurnStarted: { sessionId: Schema.String },
	TurnEnded: { sessionId: Schema.String },
	Notified: { sessionId: Schema.String, message: Schema.String },
	SessionEnded: { sessionId: Schema.String, reason: Schema.String },
	// The agent ran a skill, by its own name (`sreview`), without any plugin's prefix.
	SkillInvoked: { sessionId: Schema.String, skill: Schema.String },
	// The agent, or its subagent `agentId`, finished a tool call. The agent's own skills are SkillInvoked instead.
	ToolUsed: { sessionId: Schema.String, agentId: Schema.NullOr(Schema.String) },
});

export type AgentEvent = typeof AgentEvent.Type;

export type AgentAdapter = {
	// None for an event that is not about the agent's own session, e.g. one of its subagents', but for a subagent's tool call.
	readonly decode: (payload: string) => Effect.Effect<Option.Option<AgentEvent>, Schema.SchemaError>;
	// What the hook prints after a tool call so the agent reads `text` before it goes on.
	readonly toolContext: (text: string) => string;
};
