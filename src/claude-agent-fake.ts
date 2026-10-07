import { randomUUID } from 'node:crypto';
import type { McpSdkServerConfigWithInstance, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Clock, Data, Effect, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from 'effect';
import { ClaudeAgent } from './manager.ts';

export class FakeAgentError extends Data.TaggedError('FakeAgentError')<{ readonly message: string }> {}

// One `query` the manager made: the session it runs, its options, the text of each input it read with the input's
// priority, and whether the manager closed it.
export type FakeAgentSession = {
	readonly id: string;
	readonly options: Options;
	readonly inputs: Array<{ readonly text: string; readonly priority: SDKUserMessage['priority'] }>;
	closed: boolean;
};

export type SendMessageArguments = { readonly text: string; readonly reply_to?: string };

// What a request put in the model's context: its new input, and what it read from and wrote to the prompt cache.
export type FakeContext = { readonly input: number; readonly cacheRead: number; readonly cacheCreation: number };

const textOf = ({ message }: SDKUserMessage) =>
	typeof message.content === 'string' ? message.content : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

// An assistant message with one text block, as the SDK emits it.
const assistantText = (text: string, sessionId: string, { input, cacheRead, cacheCreation }: FakeContext): SDKMessage => ({
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
			cache_creation_input_tokens: cacheCreation,
			cache_read_input_tokens: cacheRead,
			fallback_credit: null,
			inference_geo: null,
			input_tokens: input,
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

// The end of a turn, as the SDK reports it; its usage sums every request of the turn, here the one.
const turnResult = (sessionId: string, { input, cacheRead, cacheCreation }: FakeContext): SDKMessage => ({
	type: 'result',
	subtype: 'success',
	duration_ms: 1200,
	duration_api_ms: 1000,
	is_error: false,
	num_turns: 1,
	result: 'Done.',
	stop_reason: 'end_turn',
	total_cost_usd: 0.01,
	usage: {
		cache_creation: { ephemeral_1h_input_tokens: cacheCreation, ephemeral_5m_input_tokens: 0 },
		cache_creation_input_tokens: cacheCreation,
		cache_read_input_tokens: cacheRead,
		fallback_credit: null,
		inference_geo: 'us',
		input_tokens: input,
		iterations: [],
		output_tokens: 5,
		output_tokens_details: { thinking_tokens: 0 },
		server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
		service_tier: 'standard',
		speed: 'standard',
	},
	modelUsage: {},
	permission_denials: [],
	uuid: randomUUID(),
	session_id: sessionId,
});

const smallContext: FakeContext = { input: 10, cacheRead: 0, cacheCreation: 0 };

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

// The Agent SDK's `query` and `getSessionInfo` as the manager calls them, without Claude: each session reads its prompt
// as the SDK does, input by input as they come, and only says, calls a tool, ends a turn or fails when told to. `answer`
// is called with each input's text; what it returns, if anything, is sent with `send_message`. Like Claude Code, a
// session has a transcript once it read an input, which `getSessionInfo` finds, and resuming one without fails at once.
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
		// When each session's transcript last changed.
		const transcripts = new Map<string, number>();

		const writeTranscript = (sessionId: string) => Clock.currentTimeMillis.pipe(Effect.map((now) => void transcripts.set(sessionId, now)));

		const latest = <A>(of: ReadonlyArray<A>): Effect.Effect<A, FakeAgentError> =>
			Option.match(Option.fromUndefinedOr(of.at(-1)), { onNone: () => Effect.fail(new FakeAgentError({ message: 'no session started' })), onSome: Effect.succeed });

		const callTool = (name: string, args: Record<string, unknown>) =>
			latest(clients).pipe(
				Effect.flatten,
				Effect.flatMap((client) =>
					Effect.tryPromise({ try: () => client.callTool({ name, arguments: args }), catch: (cause) => new FakeAgentError({ message: `cannot call ${name}: ${cause}` }) }),
				),
			);

		// The newest session writes the messages to its output and transcript.
		const emit = (...messages: ReadonlyArray<(sessionId: string) => SDKMessage>) =>
			Effect.gen(function* () {
				const session = yield* latest(sessions);
				const output = yield* latest(outputs);

				yield* writeTranscript(session.id);
				yield* Queue.offerAll(output, messages.map((message) => message(session.id)));
			});

		const readPrompt = (session: FakeAgentSession, prompt: AsyncIterable<SDKUserMessage>, client: Effect.Effect<Client, FakeAgentError>) =>
			Stream.fromAsyncIterable(prompt, (cause) => new FakeAgentError({ message: `cannot read the prompt: ${cause}` })).pipe(
				Stream.runForEach((message) =>
					Effect.gen(function* () {
						const text = textOf(message);

						session.inputs.push({ text, priority: message.priority });
						yield* writeTranscript(session.id);

						const reply = answer(text);

						if (reply !== null) {
							yield* client.pipe(Effect.flatMap((connected) => Effect.promise(() => connected.callTool({ name: 'send_message', arguments: reply }))));
						}

						yield* SubscriptionRef.update(read, (count) => count + 1);
					}),
				),
			);

		const query: ClaudeAgent['Service']['query'] = ({ prompt, options }) => {
			const session: FakeAgentSession = { id: options.resume ?? options.sessionId ?? randomUUID(), options, inputs: [], closed: false };
			const output = Effect.runSync(Queue.unbounded<SDKMessage, FakeAgentError>());
			const client = Effect.runSync(Effect.cached(connect(options)));
			const missing = options.resume !== undefined && !transcripts.has(options.resume);

			sessions.push(session);
			clients.push(client);
			outputs.push(output);

			const reader = runFork(
				SubscriptionRef.update(started, (count) => count + 1).pipe(
					Effect.andThen(
						missing ? Queue.fail(output, new FakeAgentError({ message: `No conversation found with session ID: ${session.id}` })) : readPrompt(session, prompt, client),
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

		const getSessionInfo: ClaudeAgent['Service']['getSessionInfo'] = (sessionId) =>
			Promise.resolve(Option.getOrUndefined(Option.map(Option.fromUndefinedOr(transcripts.get(sessionId)), (lastModified) => ({ sessionId, summary: 'The main chat', lastModified }))));

		const awaitCount = (count: SubscriptionRef.SubscriptionRef<number>, n: number) =>
			SubscriptionRef.changes(count).pipe(
				Stream.takeUntil((value) => value >= n),
				Stream.runDrain,
			);

		return {
			layer: Layer.succeed(ClaudeAgent, ClaudeAgent.of({ query, getSessionInfo })),
			sessions,
			// Until n sessions started, were closed, or n inputs were read across all sessions.
			awaitSessions: (n: number) => awaitCount(started, n),
			awaitClosed: (n: number) => awaitCount(closed, n),
			awaitInputs: (n: number) => awaitCount(read, n),
			callTool,
			// The newest session writes text, as Claude does outside any tool call.
			say: (text: string) => emit((sessionId) => assistantText(text, sessionId, smallContext)),
			// The newest session ends its turn with one last request, whose context is `context`.
			endTurn: (context: FakeContext = smallContext) =>
				emit(
					(sessionId) => assistantText('Done.', sessionId, context),
					(sessionId) => turnResult(sessionId, context),
				),
			// The session's transcript is gone, as after Claude Code's cleanup.
			forget: (sessionId: string) => Effect.sync(() => void transcripts.delete(sessionId)),
			// The newest session fails, as when Claude Code exits.
			crash: (message: string) => latest(outputs).pipe(Effect.flatMap((output) => Queue.fail(output, new FakeAgentError({ message })))),
		};
	});

export type FakeClaudeAgentControls = Effect.Success<ReturnType<typeof fakeClaudeAgent>>;
