import { join } from 'node:path';
import { NodeSocketServer } from '@effect/platform-node';
import { Cause, Context, Effect, FileSystem, Layer, Option, Schema, Struct } from 'effect';
import { Socket } from 'effect/socket';
import type { AgentAdapter } from './agent-event.ts';
import { eventSocketName } from './agent-hook.ts';
import { Phase } from './chat.ts';
import { claudeAdapter } from './claude-hooks.ts';
import { AppConfig } from './config.ts';
import { makeContextCheck } from './handoffs.ts';
import { Journal } from './journal.ts';
import { isInFlight, isStarted } from './observation.ts';
import { Reconciler } from './reconciler.ts';

// One adapter per coding agent, by the name its hook passes to `sapphire hook <agent>`.
const adapters = { claude: claudeAdapter } satisfies Record<string, AgentAdapter>;

const EventEnvelope = Schema.fromJsonString(Schema.Struct({ agent: Schema.Literals(Struct.keys(adapters)), paneId: Schema.NullOr(Schema.String), payload: Schema.String }));

// Session events from the coding agents' hooks, on `<state dir>/events.sock` while the service runs. An event from the
// pane of a run or command in flight wakes the reconciler, and a session start that changes a run's session (a resume
// of another, a clear, a fork) records a `session` request, which the requests rule applies to the run. A run's skill
// that starts a phase records a `phase` request, which the topics rule posts in the epic's thread. A tool call or a
// turn's end of a run's agent or its subagents checks their context for a handoff (`handoffs.ts`); what the subagent is
// told goes back in the answer. Events from any other pane are answered and dropped.
export class AgentEventServer extends Context.Service<
	AgentEventServer,
	{
		readonly path: string;
	}
>()('sapphire-agent/AgentEventServer') {
	static readonly layer = Layer.effect(
		AgentEventServer,
		Effect.gen(function* () {
			const { env } = yield* AppConfig;
			const journal = yield* Journal;
			const reconciler = yield* Reconciler;
			const checkContext = yield* makeContextCheck;
			const fs = yield* FileSystem.FileSystem;
			const path = join(env.stateDirectory, eventSocketName);

			// What the hook prints for the agent, if anything.
			const receive = (line: string) =>
				Effect.gen(function* () {
					const { agent, paneId, payload } = yield* Schema.decodeUnknownEffect(EventEnvelope)(line);
					const adapter = adapters[agent];
					const decoded = yield* adapter.decode(payload);

					if (Option.isNone(decoded) || paneId === null) {
						return Option.none<string>();
					}

					const event = decoded.value;
					const run = (yield* journal.listRuns).find((candidate) => isInFlight(candidate) && candidate.paneId === paneId);
					const command = (yield* journal.listCommands).find((candidate) => (candidate.status === 'claimed' || candidate.status === 'running') && candidate.paneId === paneId);

					if (run === undefined && command === undefined) {
						return Option.none<string>();
					}

					yield* Effect.logDebug(`${agent} ${event._tag} in ${paneId}`);

					if (run !== undefined && event._tag === 'SessionStarted' && run.session?.id !== event.sessionId) {
						yield* journal.addRequest({ _tag: 'session', identifier: run.identifier, sessionId: event.sessionId });
						yield* Effect.log(`${run.identifier}'s ${agent} session is now ${event.sessionId} (${event.source})`);
					}

					if (run !== undefined && event._tag === 'SkillInvoked' && Schema.is(Phase)(event.skill)) {
						yield* journal.addRequest({ _tag: 'phase', identifier: run.identifier, phase: event.skill });
					}

					const context =
						run !== undefined && isStarted(run) && (event._tag === 'ToolUsed' || event._tag === 'SkillInvoked' || event._tag === 'TurnEnded')
							? yield* checkContext(run, event.sessionId, event._tag === 'ToolUsed' ? event.agentId : null)
							: Option.none<string>();

					// Tool calls come too often to tick on each; the context check wakes the reconciler when it recorded something.
					if (event._tag !== 'ToolUsed') {
						yield* reconciler.wake;
					}

					return Option.map(context, adapter.toolContext);
				});

			const handle = (socket: Socket.Socket) =>
				Effect.gen(function* () {
					// Read in this scope rather than as a stream, whose own scope would close the connection before the answer.
					const reader = yield* socket.reader;
					const writer = yield* socket.writer;
					const decoder = new TextDecoder();
					let received = '';

					while (!received.includes('\n')) {
						for (const chunk of yield* reader.pull) {
							received += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
						}
					}

					const answer = yield* receive(received.slice(0, received.indexOf('\n'))).pipe(
						Effect.map(Option.match({ onNone: () => 'ok', onSome: (output) => `ok\n${output}` })),
						Effect.catchTag('SchemaError', (error) =>
							Effect.logWarning('refused an agent event that does not match its schema', error).pipe(Effect.as(error.message.replaceAll('\n', ' '))),
						),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError('cannot handle an agent event', cause).pipe(Effect.as('cannot record the event')),
						),
					);

					yield* writer.write(`${answer}\n`);
					yield* writer.write(new Socket.CloseEvent());
				}).pipe(
					Effect.scoped,
					Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning('lost an agent event connection', cause))),
				);

			// A socket file left by a process that did not shut down cleanly would make listening fail.
			yield* fs.remove(path, { force: true });

			const server = yield* NodeSocketServer.make({ path });

			yield* Effect.forkScoped(server.run(handle));
			yield* Effect.log(`listening for agent events on ${path}`);

			return AgentEventServer.of({ path });
		}),
	);
}
