import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createSdkMcpServer, type Options, type Query, query, type SDKMessage, type SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk';
import { Cause, Context, Deferred, Duration, Effect, Layer, Option, Queue, Ref, Schema, Stream } from 'effect';
import { z } from 'zod';
import { Chat, type MessageRef } from './chat.ts';
import { AppConfig } from './config.ts';
import { Prompts } from './prompts.ts';

export class ManagerError extends Schema.TaggedError<ManagerError>()('ManagerError', { message: Schema.String }) {}

// What the manager is told: a message in the main chat, or one line about a run's or command's agent.
export type ManagerInput = { readonly _tag: 'message'; readonly ref: MessageRef; readonly text: string } | { readonly _tag: 'agentEvent'; readonly line: string };

const inputText = (input: ManagerInput) => (input._tag === 'message' ? `Message ${input.ref} from the user:\n${input.text}` : `Agent event: ${input.line}`);

// The manager's inputs, in the order they came, kept across its restarts. It never closes.
export class ManagerInbox extends Context.Service<
	ManagerInbox,
	{
		readonly offer: (input: ManagerInput) => Effect.Effect<void>;
		readonly take: Effect.Effect<ManagerInput>;
	}
>()('sapphire-agent/ManagerInbox') {
	static readonly layer = Layer.effect(
		ManagerInbox,
		Effect.map(Queue.unbounded<ManagerInput>(), (queue) => ManagerInbox.of({ offer: (input) => Queue.offer(queue, input).pipe(Effect.asVoid), take: Queue.take(queue) })),
	);
}

// The Agent SDK's `query`, as the manager uses it; the boundary its tests fake.
export class ClaudeAgent extends Context.Service<
	ClaudeAgent,
	{
		readonly query: (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => AsyncIterable<SDKMessage> & Pick<Query, 'close'>;
	}
>()('sapphire-agent/ClaudeAgent') {
	static readonly layer = Layer.succeed(ClaudeAgent, ClaudeAgent.of({ query }));
}

const managerServerName = 'sapphire';

const restartDelay = Duration.seconds(5);

// `next` folds a message into the running turn at its next tool call, instead of holding it until the turn ends.
const userMessage = (input: ManagerInput): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: inputText(input) }, parent_tool_use_id: null, priority: 'next' });

const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

// The main chat's manager: one long-lived Claude Agent SDK session, with the user's settings, that takes every input
// from the inbox as it comes, mid-turn too. It reaches the user only through its `send_message` tool; its plain text is
// never sent. When the session fails or ends, it is logged and started again a few seconds later, resuming the session
// once it took an input.
export const runManager = Effect.gen(function* () {
	const { query } = yield* ClaudeAgent;
	const inbox = yield* ManagerInbox;
	const chat = yield* Chat;
	const prompts = yield* Prompts;
	const { env } = yield* AppConfig;
	const run = Effect.runPromiseWith(yield* Effect.context<never>());
	const resumable = yield* Ref.make(Option.none<string>());

	const sendMessage = tool(
		'send_message',
		'Sends a message to the user in the main chat: a new message, or a reply to the message whose ref you give. Markdown: bold, italic, inline code, code blocks and links.',
		{ text: z.string().min(1), reply_to: z.string().optional().describe('The ref of a user message to reply to') },
		({ text, reply_to }) =>
			run(
				chat.send(reply_to === undefined ? { _tag: 'notice', thread: null, text, key: null } : { _tag: 'reply', to: reply_to, text }).pipe(
					Effect.as(toolText('Sent.')),
					Effect.catch((error) => Effect.logError("cannot send the manager's message", error).pipe(Effect.as({ ...toolText(`Not sent: ${error.message}`), isError: true }))),
				),
			),
	);

	const session = Effect.scoped(
		Effect.gen(function* () {
			const resume = yield* Ref.getAndSet(resumable, Option.none());
			const sessionId = Option.getOrElse(resume, () => randomUUID());
			const closed = yield* Deferred.make<void>();

			// The SDK may still be reading the prompt when the session fails; the read stops, so no input is lost to it.
			yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

			const prompt = yield* Stream.fromEffectRepeat(inbox.take).pipe(
				Stream.interruptWhen(Deferred.await(closed)),
				Stream.tap(() => Ref.set(resumable, Option.some(sessionId))),
				Stream.map(userMessage),
				Stream.toAsyncIterableEffect,
			);
			const messages = query({
				prompt,
				options: {
					cwd: homedir(),
					settingSources: ['user', 'project', 'local'],
					systemPrompt: { type: 'preset', preset: 'claude_code', append: prompts.manager(env.claudeConfigDirectory) },
					mcpServers: { [managerServerName]: createSdkMcpServer({ name: managerServerName, tools: [sendMessage] }) },
					allowedTools: [`mcp__${managerServerName}__send_message`],
					...Option.match(resume, { onNone: () => ({ sessionId }), onSome: (id) => ({ resume: id }) }),
				},
			});

			yield* Effect.addFinalizer(() => Effect.sync(() => messages.close()));
			yield* Effect.log(Option.isSome(resume) ? `the manager resumed session ${sessionId}` : `the manager started session ${sessionId}`);
			yield* Stream.fromAsyncIterable(messages, (error) => new ManagerError({ message: `the manager session failed: ${error instanceof Error ? error.message : String(error)}` })).pipe(
				Stream.runForEach((message) => (message.type === 'result' && message.is_error ? Effect.logWarning(`a manager turn failed: ${message.subtype}`) : Effect.void)),
			);

			return yield* new ManagerError({ message: 'the manager session ended' });
		}),
	);

	return yield* session.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError('the manager stopped; starting it again', cause).pipe(Effect.andThen(Effect.sleep(restartDelay))),
		),
		Effect.forever,
	);
});
