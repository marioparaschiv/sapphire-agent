import { randomUUID } from 'node:crypto';
import { Effect, Option, Schedule, Stream } from 'effect';
import { Chat, type InboundMessage } from './chat.ts';
import { ClaudeChat } from './claude-chat.ts';
import { Journal } from './journal.ts';

export const unknownContext = "I don't know which conversation that message belongs to, so I can't continue from it. Reply to one of my answers, or send a new message.";

export const emptyAnswer = 'Claude answered without any text.';

// About as often as the prompt cache would expire, an hour after its last use.
const keepAliveInterval = '55 minutes';

// Core's side of the chat, until interrupted. Each main-chat message is one Claude turn, its reply streamed back; turns
// run concurrently. A reply continues the session of the bot message it replies to, forked, so every bot message keeps
// its own context; a message that replies to nothing starts a new session. A failed turn or answer is logged.
export const answerChatMessages = Effect.gen(function* () {
	const chat = yield* Chat;
	const journal = yield* Journal;
	const claude = yield* ClaudeChat;

	const turn = (message: InboundMessage) =>
		Effect.gen(function* () {
			const parent = message.replyTo === null ? Option.none<string>() : yield* journal.chatSession(message.replyTo);

			if (message.replyTo !== null && Option.isNone(parent)) {
				return yield* chat.send({ _tag: 'reply', to: message.ref, text: unknownContext });
			}

			const sessionId = randomUUID();
			const text = claude.turn({ sessionId, parent, prompt: message.text }).pipe(
				Stream.orElseIfEmpty(() => Stream.make(emptyAnswer)),
				Stream.catch((error) => Effect.logWarning('the chat turn failed', error).pipe(Effect.as(`\n\n${error.message}`), Stream.fromEffect)),
			);
			const sent = yield* chat.streamReply(message.ref, text);

			yield* journal.addChatSession(sent, sessionId);
		}).pipe(Effect.catch((error) => Effect.logError('cannot answer a chat message', error)));

	const answer = (message: InboundMessage) => {
		if (message.conversation._tag === 'main') {
			return turn(message);
		}

		const { thread } = message.conversation;

		return journal.listTopics.pipe(
			Effect.flatMap((topics) =>
				Option.match(Option.fromUndefinedOr(topics.find((topic) => topic.thread === thread)), {
					onNone: () => Effect.logWarning('dropped a chat message in a thread that belongs to no epic'),
					onSome: (topic) => Effect.log(`a chat message in ${topic.identifier}'s thread is not passed on to its run`),
				}),
			),
			Effect.catch((error) => Effect.logError('cannot look up the thread of a chat message', error)),
		);
	};

	return yield* chat.inbound.pipe(
		Stream.mapEffect(answer, { concurrency: 'unbounded' }),
		Stream.runDrain,
	);
});

// Keeps the prompt cache of the newest bot message's session warm, every keepAliveInterval for as long as the service
// runs, so a reply to it after a pause does not pay for its whole context again.
export const keepChatSessionWarm = Effect.gen(function* () {
	const journal = yield* Journal;
	const claude = yield* ClaudeChat;

	const warm = journal.latestChatSession.pipe(
		Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: claude.keepAlive })),
		Effect.catch((error) => Effect.logWarning('cannot keep the chat session warm; trying again later', error)),
	);

	// Fixed, not spaced: a slow keep-alive turn does not push the next one back.
	return yield* Effect.schedule(warm, Schedule.fixed(keepAliveInterval));
});
