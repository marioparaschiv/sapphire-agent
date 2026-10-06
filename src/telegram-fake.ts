import { Context, Effect, Layer, Queue, Stream, SubscriptionRef } from 'effect';
import { Permanent } from './call-policy.ts';
import { TelegramBot, type TelegramMessage } from './telegram-bot.ts';

// Telegram in memory, as the bot's client sees it. Like mtcute, a connected bot gets each new message at once, and its
// stored update state moves past a message as soon as the message is dispatched, whether or not it was handled yet. A
// bot that connects again catches up from that state on what was written while it was down.

export type MessageSeed = {
	// The Telegram user id of the author; the message lands in their private chat with the bot.
	readonly from: number;
	// None for a message without text, e.g. a sticker.
	readonly text?: string;
	// A group chat with this id instead of the private chat.
	readonly groupChatId?: number;
	// The forum topic the message is written in; none writes in the main chat (General).
	readonly topicId?: number;
	// The message id it replies to.
	readonly replyTo?: number;
};

export type SentMessage = { readonly chatId: number; readonly text: string; readonly replyToMessageId: number };

export type FakeTelegramControls = {
	// As a user writes to the bot; returns the message id.
	readonly write: (seed: MessageSeed) => number;
	// What the bot sent, in order.
	readonly sent: ReadonlyArray<SentMessage>;
	// Completes once the bot has sent n messages in total.
	readonly awaitSent: (n: number) => Effect.Effect<void>;
	// A bot client connected for the layer's lifetime, as TelegramBot.layer is logged in. Build it again for a restart.
	readonly bot: Layer.Layer<TelegramBot>;
};

const make = Effect.gen(function* () {
	const written: Array<TelegramMessage> = [];
	const chats = new Set<number>();
	const sent: Array<SentMessage> = [];
	const sentCount = yield* SubscriptionRef.make(0);
	let dispatched = 0;
	let connected: Queue.Queue<TelegramMessage> | null = null;
	let nextMessageId = 1;

	const addMessage = (chatId: number) => {
		chats.add(chatId);

		return nextMessageId++;
	};

	const dispatch = () => {
		while (connected !== null && dispatched < written.length) {
			Queue.offerUnsafe(connected, written[dispatched]);
			dispatched += 1;
		}
	};

	const bot = Layer.effect(
		TelegramBot,
		Effect.gen(function* () {
			const received = yield* Effect.acquireRelease(Queue.unbounded<TelegramMessage>(), () =>
				Effect.sync(() => {
					connected = null;
				}),
			);

			connected = received;
			dispatch();

			return TelegramBot.of({
				messages: Stream.fromQueue(received),
				sendText: (chatId, text, replyToMessageId) =>
					Effect.suspend(() => {
						if (!chats.has(chatId)) {
							return Effect.fail(new Permanent({ message: 'Telegram refused to send a message: 400 PEER_ID_INVALID' }));
						}

						sent.push({ chatId, text, replyToMessageId });
						addMessage(chatId);

						return SubscriptionRef.update(sentCount, (count) => count + 1);
					}),
			});
		}),
	);

	return FakeTelegram.of({
		write: ({ from, text = '', groupChatId, topicId, replyTo }) => {
			const chatId = groupChatId ?? from;
			const messageId = addMessage(chatId);

			written.push({
				messageId,
				chatId,
				chatType: groupChatId === undefined ? 'private' : 'group',
				senderId: from,
				text,
				isTopicMessage: topicId !== undefined,
				replyToMessageId: replyTo ?? null,
			});
			dispatch();

			return messageId;
		},
		sent,
		awaitSent: (n) =>
			SubscriptionRef.changes(sentCount).pipe(
				Stream.takeUntil((count) => count >= n),
				Stream.runDrain,
			),
		bot,
	});
});

export class FakeTelegram extends Context.Service<FakeTelegram, FakeTelegramControls>()('sapphire-agent/FakeTelegram') {
	static readonly layer = Layer.effect(FakeTelegram, make);

	// FakeTelegram's bot client as the TelegramBot service.
	static readonly bot = Layer.unwrap(FakeTelegram.useSync(({ bot }) => bot));
}
