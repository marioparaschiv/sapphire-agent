import { randomUUID } from 'node:crypto';
import type { McpSdkServerConfigWithInstance, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Data, Effect, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from 'effect';
import { ClaudeAgent } from './manager.ts';

export class FakeAgentError extends Data.TaggedError('FakeAgentError')<{ readonly message: string }> {}

// One `query` the manager made: its options, the text of each input it read with the input's priority, and whether
// the manager closed it.
export type FakeAgentSession = {
	readonly options: Options;
	readonly inputs: Array<{ readonly text: string; readonly priority: SDKUserMessage['priority'] }>;
	closed: boolean;
};

export type SendMessageArguments = { readonly text: string; readonly reply_to?: string };

const textOf = ({ message }: SDKUserMessage) =>
	typeof message.content === 'string' ? message.content : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

// An assistant message with one text block, as the SDK emits it.
const assistantText = (text: string, sessionId: string): SDKMessage => ({
	type: 'assistant',
	message: {
		id: `msg_${randomUUID()}`,
		container: null,
		content: [{ type: 'text', text, citations: null }],
		context_management: null,
		diagnostics: null,
		model: 'claude-opus-5-5',
		role: 'assistant',
		stop_details: null,
		stop_reason: 'end_turn',
		stop_sequence: null,
		type: 'message',
		usage: {
			cache_creation: null,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			fallback_credit: null,
			inference_geo: null,
			input_tokens: 10,
			iterations: null,
			output_tokens: 5,
			output_tokens_details: null,
			server_tool_use: null,
			service_tier: null,
			speed: null,
		},
	},
	parent_tool_use_id: null,
	uuid: randomUUID(),
	session_id: sessionId,
});

// The in-process MCP server the manager gave the session, reached as Claude Code reaches it, by an MCP client.
const connect = (options: Options) =>
	Effect.gen(function* () {
		const server = Object.values(options.mcpServers ?? {}).find((config): config is McpSdkServerConfigWithInstance => 'instance' in config);

		if (server === undefined) {
			return yield* new FakeAgentError({ message: 'the session has no in-process MCP server' });
		}

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'fake-claude', version: '1.0.0' });

		yield* Effect.tryPromise({
			try: () => server.instance.connect(serverTransport).then(() => client.connect(clientTransport)),
			catch: (cause) => new FakeAgentError({ message: `cannot connect to the MCP server: ${cause}` }),
		});

		return client;
	});

// The Agent SDK's `query` as the manager calls it, without Claude: each session reads its prompt as the SDK does, input
// by input as they come, and only says, calls a tool or fails when told to. `answer` is called with each input's text;
// what it returns, if anything, is sent with `send_message`.
export const fakeClaudeAgent = (answer: (text: string) => SendMessageArguments | null = () => null) =>
	Effect.gen(function* () {
		const context = yield* Effect.context<never>();
		const runFork = Effect.runForkWith(context);
		const sessions: Array<FakeAgentSession> = [];
		const clients: Array<Effect.Effect<Client, FakeAgentError>> = [];
		const outputs: Array<Queue.Queue<SDKMessage, FakeAgentError>> = [];
		const started = yield* SubscriptionRef.make(0);
		const read = yield* SubscriptionRef.make(0);
		const closed = yield* SubscriptionRef.make(0);

		const latest = <A>(of: ReadonlyArray<A>): Effect.Effect<A, FakeAgentError> =>
			Option.match(Option.fromUndefinedOr(of.at(-1)), { onNone: () => Effect.fail(new FakeAgentError({ message: 'no session started' })), onSome: Effect.succeed });

		const callTool = (name: string, args: Record<string, unknown>) =>
			latest(clients).pipe(
				Effect.flatten,
				Effect.flatMap((client) =>
					Effect.tryPromise({ try: () => client.callTool({ name, arguments: args }), catch: (cause) => new FakeAgentError({ message: `cannot call ${name}: ${cause}` }) }),
				),
			);

		const query: ClaudeAgent['Service']['query'] = ({ prompt, options }) => {
			const session: FakeAgentSession = { options, inputs: [], closed: false };
			const output = Effect.runSync(Queue.unbounded<SDKMessage, FakeAgentError>());
			const client = Effect.runSync(Effect.cached(connect(options)));

			sessions.push(session);
			clients.push(client);
			outputs.push(output);

			const reader = runFork(
				SubscriptionRef.update(started, (count) => count + 1).pipe(
					Effect.andThen(
						Stream.fromAsyncIterable(prompt, (cause) => new FakeAgentError({ message: `cannot read the prompt: ${cause}` })).pipe(
							Stream.runForEach((message) =>
								Effect.gen(function* () {
									const text = textOf(message);

									session.inputs.push({ text, priority: message.priority });

									const reply = answer(text);

									if (reply !== null) {
										yield* client.pipe(Effect.flatMap((connected) => Effect.promise(() => connected.callTool({ name: 'send_message', arguments: reply }))));
									}

									yield* SubscriptionRef.update(read, (count) => count + 1);
								}),
							),
						),
					),
				),
			);

			return {
				[Symbol.asyncIterator]: () => Stream.toAsyncIterableWith(Stream.fromQueue(output), context)[Symbol.asyncIterator](),
				close: () => {
					session.closed = true;
					runFork(Fiber.interrupt(reader).pipe(Effect.andThen(SubscriptionRef.update(closed, (count) => count + 1))));
				},
			};
		};

		const awaitCount = (count: SubscriptionRef.SubscriptionRef<number>, n: number) =>
			SubscriptionRef.changes(count).pipe(
				Stream.takeUntil((value) => value >= n),
				Stream.runDrain,
			);

		return {
			layer: Layer.succeed(ClaudeAgent, ClaudeAgent.of({ query })),
			sessions,
			// Until n sessions started, were closed, or n inputs were read across all sessions.
			awaitSessions: (n: number) => awaitCount(started, n),
			awaitClosed: (n: number) => awaitCount(closed, n),
			awaitInputs: (n: number) => awaitCount(read, n),
			callTool,
			// The newest session writes text, as Claude does outside any tool call.
			say: (text: string) => latest(outputs).pipe(Effect.flatMap((output) => Queue.offer(output, assistantText(text, randomUUID())))),
			// The newest session fails, as when Claude Code exits.
			crash: (message: string) => latest(outputs).pipe(Effect.flatMap((output) => Queue.fail(output, new FakeAgentError({ message })))),
		};
	});

export type FakeClaudeAgentControls = Effect.Success<ReturnType<typeof fakeClaudeAgent>>;
