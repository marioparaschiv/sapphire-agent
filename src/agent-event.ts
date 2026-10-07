import { type Effect, type Option, Schema } from 'effect';

// How a session came to start: a new one, one resumed, a fresh one after a clear, the same one after a compaction, or
// a fork of another.
export const SessionSource = Schema.Literals(['startup', 'resume', 'clear', 'compact', 'fork']);

// Every event names the session and the directory the agent works in, which ties it to a run's worktree.
const session = { sessionId: Schema.String, cwd: Schema.String };

// What a coding agent reports about its session, whichever agent it is. Each agent has an adapter that turns its own
// hook payload into one of these.
export const AgentEvent = Schema.TaggedUnion({
	SessionStarted: { ...session, source: SessionSource },
	TurnStarted: session,
	TurnEnded: session,
	Notified: session,
	SessionEnded: session,
	// The agent, or its subagent `agentId`, finished a tool call.
	ToolUsed: { ...session, agentId: Schema.NullOr(Schema.String) },
	// Anything else the agent, or its subagent `agentId`, did: a tool call about to run, a subagent's turn ending.
	Acted: { ...session, agentId: Schema.NullOr(Schema.String) },
});

export type AgentEvent = typeof AgentEvent.Type;

export type AgentAdapter = {
	// None for an event the service has no use for.
	readonly decode: (payload: string) => Effect.Effect<Option.Option<AgentEvent>, Schema.SchemaError>;
	// What the hook prints after a tool call so the agent reads `text` before it goes on.
	readonly toolContext: (text: string) => string;
};
