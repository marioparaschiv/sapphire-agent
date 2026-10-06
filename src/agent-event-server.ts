import { join } from 'node:path';
import { NodeSocketServer } from '@effect/platform-node';
import { Cause, Context, Effect, FileSystem, Layer, Option, Schema, Struct } from 'effect';
import { Socket } from 'effect/socket';
import type { AgentAdapter } from './agent-event.ts';
import { eventSocketName } from './agent-hook.ts';
import { Phase } from './chat.ts';
import { decodeClaudeHook } from './claude-hooks.ts';
import { AppConfig } from './config.ts';
import { Journal } from './journal.ts';
import { isInFlight } from './observation.ts';
import { Reconciler } from './reconciler.ts';

// One adapter per coding agent, by the name its hook passes to `sapphire hook <agent>`.
const adapters = { claude: decodeClaudeHook } satisfies Record<string, AgentAdapter>;

const EventEnvelope = Schema.fromJsonString(Schema.Struct({ agent: Schema.Literals(Struct.keys(adapters)), paneId: Schema.NullOr(Schema.String), payload: Schema.String }));

// Session events from the coding agents' hooks, on `<state dir>/events.sock` while the service runs. An event from the
// pane of a run or command in flight wakes the reconciler, and a session start that changes a run's session (a resume
// of another, a clear, a fork) records a `session` request, which the requests rule applies to the run. A run's skill
// that starts a phase records a `phase` request, which the topics rule posts in the epic's thread. Events from any
// other pane are answered and dropped.
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
			const fs = yield* FileSystem.FileSystem;
			const path = join(env.stateDirectory, eventSocketName);

			const receive = (line: string) =>
				Effect.gen(function* () {
					const { agent, paneId, payload } = yield* Schema.decodeUnknownEffect(EventEnvelope)(line);
					const event = yield* adapters[agent](payload);

					if (Option.isNone(event) || paneId === null) {
						return;
					}

					const run = (yield* journal.listRuns).find((candidate) => isInFlight(candidate) && candidate.paneId === paneId);
					const command = (yield* journal.listCommands).find((candidate) => (candidate.status === 'claimed' || candidate.status === 'running') && candidate.paneId === paneId);

					if (run === undefined && command === undefined) {
						return;
					}

					yield* Effect.logDebug(`${agent} ${event.value._tag} in ${paneId}`);

					if (run !== undefined && event.value._tag === 'SessionStarted' && run.session?.id !== event.value.sessionId) {
						yield* journal.addRequest({ _tag: 'session', identifier: run.identifier, sessionId: event.value.sessionId });
						yield* Effect.log(`${run.identifier}'s ${agent} session is now ${event.value.sessionId} (${event.value.source})`);
					}

					if (run !== undefined && event.value._tag === 'SkillInvoked' && Schema.is(Phase)(event.value.skill)) {
						yield* journal.addRequest({ _tag: 'phase', identifier: run.identifier, phase: event.value.skill });
					}

					yield* reconciler.wake;
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
						Effect.as('ok'),
						Effect.catchTag('SchemaError', (error) => Effect.logWarning('refused an agent event that does not match its schema', error).pipe(Effect.as(error.message))),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError('cannot handle an agent event', cause).pipe(Effect.as('cannot record the event')),
						),
					);

					yield* writer.write(`${answer.replaceAll('\n', ' ')}\n`);
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
