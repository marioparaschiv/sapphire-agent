import { join } from 'node:path';
import { NodeSocketServer } from '@effect/platform-node';
import { Cause, Context, Effect, FileSystem, Layer, Option, Schema, Struct } from 'effect';
import { Socket } from 'effect/socket';
import { AgentActivity } from './agent-activity.ts';
import type { AgentAdapter, AgentName } from './agent-event.ts';
import { eventSocketName } from './agent-hook.ts';
import { claudeAdapter } from './claude-hooks.ts';
import { AppConfig } from './config.ts';
import { makeContextCheck } from './handoffs.ts';
import { Journal } from './journal.ts';
import { isInFlight, isInside, isThreaded } from './observation.ts';
import { piAdapter } from './pi-hooks.ts';
import { Reconciler } from './reconciler.ts';

// One adapter per coding agent, by the name its hook passes to `sapphire hook <agent>`.
const adapters = { claude: claudeAdapter, pi: piAdapter } satisfies Record<AgentName, AgentAdapter>;

const EventEnvelope = Schema.fromJsonString(Schema.Struct({ agent: Schema.Literals(Struct.keys(adapters)), payload: Schema.String }));

// Session events from the coding agents' hooks, on `<state dir>/events.sock` while the service runs. An event of a run
// or command in flight wakes the reconciler. It is matched by its T3 thread when the agent can tell it (Pi), else by
// its worktree or checkout (the hook's cwd), since T3 passes Claude nothing that names its thread. Any event of a run's
// own agent in another session records a `session` request, which the requests rule applies to the run. A tool call
// or a turn's end of a run's agent or its subagents checks their context for a handoff (`handoffs.ts`); what the
// subagent is told goes back in the answer. Any event of a run, its subagents' included, counts as its agent's
// activity (`AgentActivity`). Events from anywhere else are answered and dropped.
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
			const activity = yield* AgentActivity;
			const fs = yield* FileSystem.FileSystem;
			const path = join(env.stateDirectory, eventSocketName);

			// What the hook prints for the agent, if anything.
			const receive = (line: string) =>
				Effect.gen(function* () {
					const { agent, payload } = yield* Schema.decodeUnknownEffect(EventEnvelope)(line);
					const adapter = adapters[agent];
					const decoded = yield* adapter.decode(payload);

					if (Option.isNone(decoded)) {
						return Option.none<string>();
					}

					const event = decoded.value;
					const isFrom = (thread: string | null, directory: string | null) =>
						event.threadId === null ? directory !== null && isInside(directory, event.cwd) : thread === event.threadId;
					const run = (yield* journal.listRuns).find((candidate) => isInFlight(candidate) && isFrom(candidate.threadId, candidate.worktreePath));
					const command = (yield* journal.listCommands).find(
						(candidate) => (candidate.status === 'claimed' || candidate.status === 'running') && isFrom(candidate.threadId, candidate.cwd),
					);
					// A subagent's own session (Pi's) never becomes the run's.
					const agentId = event._tag === 'ToolUsed' || event._tag === 'Acted' ? event.agentId : null;

					if (run === undefined && command === undefined) {
						return Option.none<string>();
					}

					yield* Effect.logDebug(`${agent} ${event._tag} in ${event.cwd}`);

					// T3 shows little of what a subagent does in the background; its hooks show all of it.
					if (run !== undefined) {
						yield* activity.record(run.epicId);
					}

					// A thread's agent starts in a session T3 chose, so its first event names it.
					const changedSession =
						run !== undefined &&
						agentId === null &&
						run.session?.id !== event.sessionId &&
						!(yield* journal.listRequests).some(({ request }) => request._tag === 'session' && request.identifier === run.identifier && request.sessionId === event.sessionId);

					if (run !== undefined && changedSession) {
						yield* journal.addRequest({ _tag: 'session', identifier: run.identifier, sessionId: event.sessionId });
						yield* Effect.log(`${run.identifier}'s ${agent} session is now ${event.sessionId}${event._tag === 'SessionStarted' ? ` (${event.source})` : ''}`);
					}

					// A failed check does not fail the event, which is recorded already; the next tool call checks again.
					const context =
						run !== undefined && isThreaded(run) && (event._tag === 'ToolUsed' || event._tag === 'TurnEnded')
							? yield* checkContext(run, agent, event).pipe(
									Effect.catch((error) => Effect.logWarning(`cannot check ${run.identifier}'s context for a handoff`, error).pipe(Effect.as(Option.none<string>()))),
								)
							: Option.none<string>();

					// Tool calls come too often to tick on each; the context check wakes the reconciler when it recorded something.
					if (event._tag !== 'ToolUsed' && event._tag !== 'Acted') {
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
