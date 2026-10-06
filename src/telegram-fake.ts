import { Long, type TextWithEntities, type tl } from '@mtcute/node';
import { Context, Effect, Layer, PubSub, Queue, Stream, SubscriptionRef } from 'effect';
import { type CallError, Permanent } from './call-policy.ts';
import { type DraftStop, type SendOptions, TelegramBot, type TelegramMessage } from './telegram-bot.ts';

// Telegram in memory, as the bot's client sees it. Like mtcute, a connected bot gets each new message at once, and its
// stored update state moves past a message as soon as the message is dispatched, whether or not it was handled yet. A
// bot that connects again catches up from that state on what was written while it was down. Like Telegram, a send
// keyed by a random id that was used already is refused, and topics are numbered in the same sequence as messages.

export type MessageSeed = {
	// The Telegram user id of the author; the message lands in their private chat with the bot.
	readonly from: number;
	// None for a message without text, e.g. a sticker.
	readonly text?: string;
	// The file of a voice note instead of text.
	readonly voice?: Uint8Array;
	// A group chat with this id instead of the private chat.
	readonly groupChatId?: number;
	// The forum topic the message is written in; none writes in the main chat (General).
	readonly topicId?: number;
	// The message id it replies to.
	readonly replyTo?: number;
};

// `text` is what the user reads, its formatting in `entities`.
export type SentMessage = {
	readonly messageId: number;
	readonly chatId: number;
	readonly text: string;
	readonly entities: ReadonlyArray<tl.TypeMessageEntity>;
	readonly replyToMessageId: number | null;
	readonly topicId: number | null;
};

export type Draft = { readonly chatId: number; readonly topicId: number | null; readonly draftId: string; readonly text: string };

export type Typing = { readonly chatId: number; readonly topicId: number | null };

export type Topic = { readonly chatId: number; readonly topicId: number; readonly title: string };

export type FakeTelegramControls = {
	// As a user writes to the bot; returns the message id.
	readonly write: (seed: MessageSeed) => number;
	// As the user presses stop on the newest draft.
	readonly stopDraft: Effect.Effect<void>;
	// What the bot sent, in order.
	readonly sent: ReadonlyArray<SentMessage>;
	// Every draft update the bot made, in order.
	readonly drafts: ReadonlyArray<Draft>;
	// Every typing action the bot sent, in order.
	readonly typings: ReadonlyArray<Typing>;
	// From now on, every typing action fails with the error.
	readonly failTyping: (error: CallError) => void;
	// The topics that exist, in the order they were made, with their current titles.
	readonly topics: () => ReadonlyArray<Topic>;
	// As the user deletes a topic.
	readonly deleteTopic: (topicId: number) => void;
	// Every topic ever made, deleted ones included.
	readonly topicsCreated: () => number;
	// Completes once the bot has sent n messages in total.
	readonly awaitSent: (n: number) => Effect.Effect<void>;
	// Completes once the bot has made n draft updates in total.
	readonly awaitDrafts: (n: number) => Effect.Effect<void>;
	// Completes once the bot has sent n typing actions in total, failed ones included.
	readonly awaitTypings: (n: number) => Effect.Effect<void>;
	// Counted from this call: the nth write (send, topic or draft) after it is applied, then fails, as if the process
	// died before recording it.
	readonly crashAfterWrite: (nth: number, error: CallError) => void;
	// Writes received so far.
	readonly writes: () => number;
	// A bot client connected for the layer's lifetime, as TelegramBot.layer is logged in. Build it again for a restart.
	readonly bot: Layer.Layer<TelegramBot>;
};

const make = Effect.gen(function* () {
	const written: Array<TelegramMessage> = [];
	const files = new Map<string, Uint8Array>();
	const chats = new Set<number>();
	const sent: Array<SentMessage> = [];
	const drafts: Array<Draft> = [];
	const typings: Array<Typing> = [];
	const topics = new Map<number, Topic>();
	const usedRandomIds = new Set<string>();
	const sentCount = yield* SubscriptionRef.make(0);
	const draftCount = yield* SubscriptionRef.make(0);
	const typingCount = yield* SubscriptionRef.make(0);
	const stops = yield* PubSub.unbounded<DraftStop>();
	let dispatched = 0;
	let connected: Queue.Queue<TelegramMessage> | null = null;
	let nextMessageId = 1;
	let topicsCreated = 0;
	let writes = 0;
	let typingError: CallError | null = null;
	const crashes = new Map<number, CallError>();

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

	const refused = (what: string, text: string) => Effect.fail(new Permanent({ message: `Telegram refused to ${what}: 400 ${text}` }));

	const write = <A>(apply: () => Effect.Effect<A, CallError>) =>
		Effect.suspend(() => {
			writes += 1;

			const crash = crashes.get(writes);

			return crash === undefined ? apply() : apply().pipe(Effect.andThen(Effect.fail(crash)));
		});

	const knownChat = <A>(chatId: number, what: string, apply: () => Effect.Effect<A, CallError>) =>
		Effect.suspend(() => (chats.has(chatId) ? apply() : refused(what, 'PEER_ID_INVALID')));

	const send = (chatId: number, { text, entities = [] }: TextWithEntities, { replyTo, topicId }: SendOptions = {}) =>
		Effect.suspend(() => {
			if (topicId !== undefined && !topics.has(topicId)) {
				return refused('send a message', 'TOPIC_DELETED');
			}

			const messageId = addMessage(chatId);

			sent.push({ messageId, chatId, text, entities, replyToMessageId: replyTo ?? null, topicId: topicId ?? null });

			return SubscriptionRef.update(sentCount, (count) => count + 1).pipe(Effect.as(messageId));
		});

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
				draftStops: Stream.fromPubSub(stops),
				sendText: (chatId, text, options) => write(() => knownChat(chatId, 'send a message', () => send(chatId, text, options))),
				sendOnce: (chatId, text, key, options) =>
					write(() =>
						knownChat(chatId, 'send a message', () => {
							if (usedRandomIds.has(`${chatId}:${key}`)) {
								return Effect.void;
							}

							return send(chatId, text, options).pipe(
								Effect.andThen(Effect.sync(() => usedRandomIds.add(`${chatId}:${key}`))),
								Effect.asVoid,
							);
						}),
					),
				sendDraft: (chatId, topicId, draftId, text) =>
					write(() =>
						knownChat(chatId, 'show a draft', () => {
							drafts.push({ chatId, topicId, draftId: draftId.toString(), text: text.text });

							return SubscriptionRef.update(draftCount, (count) => count + 1);
						}),
					),
				sendTyping: (chatId, topicId) =>
					knownChat(chatId, 'show that the bot is typing', () => {
						typings.push({ chatId, topicId });

						return SubscriptionRef.update(typingCount, (count) => count + 1).pipe(Effect.andThen(typingError === null ? Effect.void : Effect.fail(typingError)));
					}),
				createTopic: (chatId, title) =>
					write(() =>
						knownChat(chatId, 'create a topic', () =>
							Effect.sync(() => {
								const topicId = addMessage(chatId);

								topics.set(topicId, { chatId, topicId, title });
								topicsCreated += 1;

								return topicId;
							}),
						),
					),
				editTopic: (chatId, topicId, title) =>
					write(() =>
						knownChat(chatId, 'rename a topic', () => {
							if (!topics.has(topicId)) {
								return refused('rename a topic', 'TOPIC_ID_INVALID');
							}

							topics.set(topicId, { chatId, topicId, title });

							return Effect.void;
						}),
					),
				deleteTopic: (chatId, topicId) =>
					write(() =>
						knownChat(chatId, 'delete a topic', () =>
							Effect.sync(() => {
								topics.delete(topicId);
							}),
						),
					),
				existingTopics: (chatId, topicIds) => Effect.sync(() => topicIds.filter((topicId) => topics.get(topicId)?.chatId === chatId)),
				download: (fileId) => Effect.suspend(() => Effect.fromNullishOr(files.get(fileId)).pipe(Effect.mapError(() => new Permanent({ message: 'Telegram refused to download a file: 400 FILE_ID_INVALID' })))),
			});
		}),
	);

	const awaitCount = (count: SubscriptionRef.SubscriptionRef<number>, n: number) =>
		SubscriptionRef.changes(count).pipe(
			Stream.takeUntil((current) => current >= n),
			Stream.runDrain,
		);

	return FakeTelegram.of({
		write: ({ from, text = '', voice, groupChatId, topicId, replyTo }) => {
			const chatId = groupChatId ?? from;
			const messageId = addMessage(chatId);
			const voiceFileId = voice === undefined ? null : `voice-${messageId}`;

			if (voiceFileId !== null && voice !== undefined) {
				files.set(voiceFileId, voice);
			}

			written.push({
				messageId,
				chatId,
				chatType: groupChatId === undefined ? 'private' : 'group',
				senderId: from,
				text,
				topicId: topicId ?? null,
				replyToMessageId: replyTo ?? null,
				voiceFileId,
			});
			dispatch();

			return messageId;
		},
		stopDraft: Effect.suspend(() => {
			const draft = drafts.at(-1);

			if (draft === undefined) {
				return Effect.die(new Error('no draft to stop'));
			}

			return PubSub.publish(stops, { chatId: draft.chatId, topicId: draft.topicId, draftId: Long.fromString(draft.draftId) }).pipe(Effect.asVoid);
		}),
		sent,
		drafts,
		typings,
		failTyping: (error) => {
			typingError = error;
		},
		topics: () => [...topics.values()],
		deleteTopic: (topicId) => {
			topics.delete(topicId);
		},
		topicsCreated: () => topicsCreated,
		awaitSent: (n) => awaitCount(sentCount, n),
		awaitDrafts: (n) => awaitCount(draftCount, n),
		awaitTypings: (n) => awaitCount(typingCount, n),
		crashAfterWrite: (nth, error) => {
			crashes.set(writes + nth, error);
		},
		writes: () => writes,
		bot,
	});
});

export class FakeTelegram extends Context.Service<FakeTelegram, FakeTelegramControls>()('sapphire-agent/FakeTelegram') {
	static readonly layer = Layer.effect(FakeTelegram, make);

	// FakeTelegram's bot client as the TelegramBot service.
	static readonly bot = Layer.unwrap(FakeTelegram.useSync(({ bot }) => bot));
}
