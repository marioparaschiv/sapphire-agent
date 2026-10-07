import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	createSdkMcpServer,
	type GetSessionInfoOptions,
	getSessionInfo,
	type Options,
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKSessionInfo,
	type SDKUserMessage,
	tool,
} from '@anthropic-ai/claude-agent-sdk';
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, FileSystem, Layer, Option, Queue, Ref, Schema, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';
import { Chat, type MessageRef } from './chat.ts';
import { readPromptCacheTtl } from './claude-settings.ts';
import { AppConfig } from './config.ts';
import { Journal } from './journal.ts';
import { Prompts } from './prompts.ts';

export class ManagerError extends Schema.TaggedError<ManagerError>()('ManagerError', { message: Schema.String }) {}

// What the manager is told: a message in the main chat, or one line about a run's or command's agent.
export type ManagerInput = { readonly _tag: 'message'; readonly ref: MessageRef; readonly text: string } | { readonly _tag: 'agentEvent'; readonly line: string };

// Asks the session `sessionId` for its summary before it is replaced, ahead of the inputs after it. Another session
// drops it.
type Rotation = { readonly _tag: 'rotate'; readonly sessionId: string };

// What a session reads: its inputs, the summary the session before it wrote, and the request for its own summary.
type SessionInput = ManagerInput | { readonly _tag: 'summary'; readonly text: string } | { readonly _tag: 'summarize'; readonly path: string };

// The manager's inputs, in the order they came, kept across its restarts and rotations. It never closes.
export class ManagerInbox extends Context.Service<
	ManagerInbox,
	{
		readonly offer: (input: ManagerInput) => Effect.Effect<void>;
		readonly rotate: (sessionId: string) => Effect.Effect<void>;
		readonly take: Effect.Effect<ManagerInput | Rotation>;
	}
>()('sapphire-agent/ManagerInbox') {
	static readonly layer = Layer.effect(
		ManagerInbox,
		Effect.map(Queue.unbounded<ManagerInput | Rotation>(), (queue) =>
			ManagerInbox.of({
				offer: (input) => Queue.offer(queue, input).pipe(Effect.asVoid),
				rotate: (sessionId) => Queue.offer(queue, { _tag: 'rotate', sessionId }).pipe(Effect.asVoid),
				take: Queue.take(queue),
			}),
		),
	);
}

// The Agent SDK's `query` and `getSessionInfo`, as the manager uses them; the boundary its tests fake.
export class ClaudeAgent extends Context.Service<
	ClaudeAgent,
	{
		readonly query: (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => AsyncIterable<SDKMessage> & Pick<Query, 'close'>;
		readonly getSessionInfo: (sessionId: string, options: GetSessionInfoOptions) => Promise<SDKSessionInfo | undefined>;
	}
>()('sapphire-agent/ClaudeAgent') {
	static readonly layer = Layer.succeed(ClaudeAgent, ClaudeAgent.of({ query, getSessionInfo }));
}

const managerServerName = 'sapphire';

const restartDelay = Duration.seconds(5);

// How long a session asked for its summary may take to write it before it is replaced without one.
export const summaryTimeout = Duration.minutes(5);

// `next` folds a message into the running turn at its next tool call, instead of holding it until the turn ends.
const userMessage = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: 'next' });

const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

// What the request behind an assistant message put in the model's context.
const contextTokens = ({ input_tokens, cache_read_input_tokens, cache_creation_input_tokens }: SDKAssistantMessage['message']['usage']) =>
	input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0);

// How long the main chat may sit idle before its manager is replaced; none, with a warning, when that is not known.
const idleLimit = readPromptCacheTtl.pipe(
	Effect.tap(Option.match({ onNone: () => Effect.logWarning("settings.json sets no promptCacheTtl, so the manager's session is not replaced when the main chat is idle"), onSome: () => Effect.void })),
	Effect.catch((error) =>
		Effect.logWarning("cannot read promptCacheTtl from settings.json, so the manager's session is not replaced when the main chat is idle", error).pipe(Effect.as(Option.none<Duration.Duration>())),
	),
);

// The main chat's manager: one Claude Agent SDK session at a time, with the user's settings, that takes every input from
// the inbox as it comes, mid-turn too. It reaches the user only through its `send_message` tool; its plain text is never
// sent. When the session fails or ends, it is logged and started again a few seconds later.
//
// The journal holds the session to run and the summary it starts from. A session Claude still has is resumed, after a
// crash or a restart; one it does not have is started with the summary as its first input. Once the main chat was idle
// for promptCacheTtl, or a turn ended with its context at managerRotateAtTokens, the session is asked to write its
// summary with the compact-summary skill, reads nothing more, and is closed once a turn ended with the summary written,
// or after summaryTimeout. The next session, with that summary or none, is recorded, then started.
export const runManager = Effect.gen(function* () {
	const agent = yield* ClaudeAgent;
	const inbox = yield* ManagerInbox;
	const chat = yield* Chat;
	const prompts = yield* Prompts;
	const journal = yield* Journal;
	const fs = yield* FileSystem.FileSystem;
	const { env, managerRotateAtTokens } = yield* AppConfig;
	const run = Effect.runPromiseWith(yield* Effect.context<never>());
	const idleAfter = yield* idleLimit;

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

	const inputText = (input: SessionInput) => {
		switch (input._tag) {
			case 'message':
				return `Message ${input.ref} from the user:\n${input.text}`;
			case 'agentEvent':
				return `Agent event: ${input.line}`;
			case 'summary':
				return `Summary of the previous session:\n${input.text}`;
			case 'summarize':
				return prompts.managerSummary(input.path);
		}
	};

	// The stored session, resumed when Claude has its transcript, as of its last change; otherwise started fresh with the
	// stored summary. The first session ever is recorded before it starts.
	const pickSession = Effect.gen(function* () {
		const stored = yield* journal.managerSession;

		if (Option.isNone(stored)) {
			const sessionId = randomUUID();

			yield* journal.setManagerSession({ sessionId, summary: null });

			return { sessionId, resumedFrom: Option.none<number>(), summary: Option.none<string>() };
		}

		const { sessionId, summary } = stored.value;
		const info = yield* Effect.tryPromise({
			try: () => agent.getSessionInfo(sessionId, { dir: homedir() }),
			catch: (cause) => new ManagerError({ message: `cannot look up the manager session ${sessionId}: ${cause}` }),
		});

		return info === undefined
			? { sessionId, resumedFrom: Option.none<number>(), summary: Option.fromNullOr(summary) }
			: { sessionId, resumedFrom: Option.some(info.lastModified), summary: Option.none<string>() };
	});

	const readSummary = (path: string) =>
		fs.readFileString(path).pipe(
			Effect.map((text) => Option.liftPredicate(text.trim(), (trimmed) => trimmed.length > 0)),
			Effect.catchTag('PlatformError', (error) =>
				error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.logWarning("cannot read the manager's summary", error).pipe(Effect.as(Option.none<string>())),
			),
		);

	// Records the next session with the summary the outgoing one wrote, or none when it wrote none.
	const handOver = (sessionId: string, path: string) =>
		Effect.gen(function* () {
			const summary = yield* readSummary(path);
			const next = randomUUID();

			if (Option.isNone(summary)) {
				yield* Effect.logWarning(`the manager session ${sessionId} wrote no summary to ${path}, so the next one starts without it`);
			}

			yield* journal.setManagerSession({ sessionId: next, summary: Option.getOrNull(summary) });
			yield* fs.remove(path, { force: true });
			yield* Effect.log(`the manager replaced session ${sessionId} with ${next}`);
		});

	const session = Effect.scoped(
		Effect.gen(function* () {
			const { sessionId, resumedFrom, summary } = yield* pickSession;
			const summaryPath = join(env.stateDirectory, `manager-summary-${sessionId}.md`);
			const closed = yield* Deferred.make<void>();
			const summaryAsked = yield* Deferred.make<void>();
			const rotating = yield* Ref.make(false);
			const context = yield* Ref.make(0);
			// When the session last took a message or agent event, or said anything after one. A session that took only its
			// summary is never idle, so an unused chat does not rotate again and again.
			const activity = yield* SubscriptionRef.make(resumedFrom);

			// The SDK may still be reading the prompt when the session fails; the read stops, so no input is lost to it.
			yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

			const rotate = (reason: string) =>
				Ref.getAndSet(rotating, true).pipe(
					Effect.flatMap((already) => (already ? Effect.void : Effect.log(`the manager asks session ${sessionId} for its summary: ${reason}`).pipe(Effect.andThen(inbox.rotate(sessionId))))),
				);

			const touch = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => SubscriptionRef.set(activity, Option.some(now))));

			const keepActive = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => SubscriptionRef.update(activity, Option.map(() => now))));

			const read = (item: ManagerInput | Rotation): Effect.Effect<SessionInput> =>
				item._tag === 'rotate' ? Deferred.succeed(summaryAsked, undefined).pipe(Effect.as({ _tag: 'summarize', path: summaryPath })) : touch.pipe(Effect.as(item));

			const inputs = Stream.fromEffectRepeat(inbox.take).pipe(
				Stream.filter((item) => item._tag !== 'rotate' || item.sessionId === sessionId),
				// Once asked for its summary, the session reads nothing more; what comes meanwhile is for the next one.
				Stream.takeUntil((item) => item._tag === 'rotate'),
				Stream.mapEffect(read),
				Stream.concat(Stream.never),
				Stream.interruptWhen(Deferred.await(closed)),
			);
			const prompt = yield* Stream.fromIterable(Option.toArray(summary).map((text): SessionInput => ({ _tag: 'summary', text }))).pipe(
				Stream.concat(inputs),
				Stream.map((input) => userMessage(inputText(input))),
				Stream.toAsyncIterableEffect,
			);
			const messages = agent.query({
				prompt,
				options: {
					cwd: homedir(),
					settingSources: ['user', 'project', 'local'],
					systemPrompt: { type: 'preset', preset: 'claude_code', append: prompts.manager(env.claudeConfigDirectory) },
					mcpServers: { [managerServerName]: createSdkMcpServer({ name: managerServerName, tools: [sendMessage] }) },
					allowedTools: [`mcp__${managerServerName}__send_message`],
					...(Option.isSome(resumedFrom) ? { resume: sessionId } : { sessionId }),
				},
			});

			yield* Effect.addFinalizer(() => Effect.sync(() => messages.close()));
			yield* Effect.log(Option.isSome(resumedFrom) ? `the manager resumed session ${sessionId}` : `the manager started session ${sessionId}`);

			if (Option.isSome(idleAfter)) {
				const idle = Duration.toMillis(idleAfter.value);
				const idleSince = (at: number) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, at + idle - now)))));

				yield* SubscriptionRef.changes(activity).pipe(
					Stream.switchMap(Option.match({ onNone: () => Stream.never, onSome: (at) => Stream.fromEffect(idleSince(at)) })),
					Stream.take(1),
					Stream.runDrain,
					Effect.andThen(rotate(`the main chat was idle for ${Duration.format(idleAfter.value)}`)),
					Effect.forkScoped,
				);
			}

			const observe = (message: SDKMessage) =>
				Effect.gen(function* () {
					yield* keepActive;

					if (message.type === 'assistant' && message.parent_tool_use_id === null) {
						yield* Ref.set(context, contextTokens(message.message.usage));
					}

					if (message.type !== 'result') {
						return;
					}

					if (message.is_error) {
						yield* Effect.logWarning(`a manager turn failed: ${message.subtype}`);
					}

					const tokens = yield* Ref.get(context);

					if (tokens >= managerRotateAtTokens) {
						yield* rotate(`its context reached ${tokens} tokens`);
					}
				});

			// A turn that ends before the summary is written may be another one the request did not reach yet.
			const summaryWritten = (message: SDKMessage) =>
				Effect.gen(function* () {
					return message.type === 'result' && (yield* Deferred.isDone(summaryAsked)) && (yield* fs.exists(summaryPath));
				});

			const ended = yield* Stream.fromAsyncIterable(messages, (error) => new ManagerError({ message: `the manager session failed: ${error instanceof Error ? error.message : String(error)}` })).pipe(
				Stream.tap(observe),
				Stream.takeUntilEffect(summaryWritten),
				Stream.interruptWhen(Deferred.await(summaryAsked).pipe(Effect.andThen(Effect.sleep(summaryTimeout)))),
				Stream.runDrain,
				Effect.exit,
			);

			if (!(yield* Deferred.isDone(summaryAsked))) {
				return yield* Exit.isFailure(ended) ? Effect.failCause(ended.cause) : new ManagerError({ message: 'the manager session ended' });
			}

			if (Exit.isFailure(ended)) {
				yield* Effect.logWarning('the manager session failed while it wrote its summary', ended.cause);
			}

			yield* handOver(sessionId, summaryPath);
		}),
	);

	return yield* session.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError('the manager stopped; starting it again', cause).pipe(Effect.andThen(Effect.sleep(restartDelay))),
		),
		Effect.forever,
	);
});
