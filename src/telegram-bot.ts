import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
	BaseSqliteStorage,
	BaseSqliteStorageDriver,
	type ISqliteDatabase,
	Long,
	type Message,
	MtcuteError,
	MtTimeoutError,
	TelegramClient,
	tl,
} from '@mtcute/node';
import { LogManager } from '@mtcute/node/utils.js';
import { Cause, Context, Duration, Effect, Layer, PubSub, Queue, Redacted, Stream } from 'effect';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy, withWritePolicy } from './call-policy.ts';
import { AppConfig, TelegramConfig } from './config.ts';

// A new message the bot can see, reduced to what the Telegram Chat adapter reads.
export type TelegramMessage = {
	readonly messageId: number;
	readonly chatId: number;
	// `private` for a chat with one user; otherwise the group or channel kind.
	readonly chatType: string;
	readonly senderId: number;
	// Empty for a message without text, e.g. a sticker or a voice note.
	readonly text: string;
	// The forum topic it was written in; none for the main chat (General).
	readonly topicId: number | null;
	// The message it replies to; a message in a topic that replies to nothing else points at the topic, which is none.
	readonly replyToMessageId: number | null;
	// The file of a voice note, for `download`.
	readonly voiceFileId: string | null;
};

// The user pressed stop on a draft (`sendDraft`).
export type DraftStop = { readonly chatId: number; readonly topicId: number | null; readonly draftId: Long };

const toTelegramMessage = (message: Message): TelegramMessage => {
	const topicId = message.isTopicMessage ? (message.replyToMessage?.threadId ?? null) : null;
	const replyToMessageId = message.replyToMessage?.id ?? null;

	return {
		messageId: message.id,
		chatId: message.chat.id,
		chatType: message.chat.type === 'user' ? 'private' : message.chat.chatType,
		senderId: message.sender.id,
		text: message.text,
		topicId,
		replyToMessageId: replyToMessageId === topicId ? null : replyToMessageId,
		voiceFileId: message.media?.type === 'voice' ? message.media.fileId : null,
	};
};

// A random_id Telegram has seen already for the same peer refuses the send, so a send keyed by what it is for is sent
// once, also when a crash makes it run again.
const randomIdOf = (key: string) => Long.fromBytesBE([...createHash('sha256').update(key).digest().subarray(0, 8)]);

const sqlValue = (value: unknown): SQLInputValue => {
	if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) {
		return value;
	}

	throw new TypeError(`mtcute bound an unsupported SQLite value: ${typeof value}`);
};

// mtcute's own SQLite storage driver needs the native better-sqlite3; this one runs its storage on node:sqlite, as the
// journal does.
export class NodeSqliteStorageDriver extends BaseSqliteStorageDriver {
	readonly filename: string;

	constructor(filename: string) {
		super();
		this.filename = filename;
	}

	_createDatabase(): ISqliteDatabase {
		const database = new DatabaseSync(this.filename);

		database.exec('PRAGMA journal_mode = WAL');

		return {
			prepare: (sql) => {
				const statement = database.prepare(sql);

				return {
					run: (...params) => void statement.run(...params.map(sqlValue)),
					get: (...params) => statement.get(...params.map(sqlValue)),
					all: (...params) => statement.all(...params.map(sqlValue)),
				};
			},
			// better-sqlite3's transaction(): the returned function runs `fn` in one transaction, rolled back if it throws.
			transaction: (fn) =>
				((...args: Parameters<typeof fn>) => {
					database.exec('BEGIN');

					try {
						const result = fn(...args);

						database.exec('COMMIT');

						return result;
					} catch (error) {
						database.exec('ROLLBACK');
						throw error;
					}
				}) as typeof fn,
			exec: (sql) => database.exec(sql),
			close: () => database.close(),
		};
	}
}

// FLOOD_WAIT says how long to wait; 5xx and timeouts are worth retrying; any other RPC error, or mtcute refusing the
// call itself, is not. Anything else is the connection's.
const callFailure =
	(what: string) =>
	(error: unknown): CallError => {
		if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) {
			return new Transient({ message: `Telegram asked to wait ${error.seconds}s before ${what}`, retryAfter: Duration.seconds(error.seconds) });
		}

		if (tl.RpcError.is(error)) {
			return error.code === tl.RpcError.FLOOD || error.code >= 500 || error.code < 0
				? new Transient({ message: `Telegram failed to ${what}: ${error.code} ${error.text}` })
				: new Permanent({ message: `Telegram refused to ${what}: ${error.code} ${error.text}` });
		}

		if (error instanceof MtcuteError && !(error instanceof MtTimeoutError)) {
			return new Permanent({ message: `cannot ${what}: ${error.message}` });
		}

		return new Transient({ message: `Telegram could not be reached to ${what}: ${error instanceof Error ? error.message : String(error)}` });
	};

export type SendOptions = {
	readonly replyTo?: number;
	readonly topicId?: number;
};

// The bot's MTProto client (mtcute), logged in with the bot token for as long as the layer lives. mtcute keeps its
// session and update state in `telegram.session` in the state directory, and catches up on what was sent while the
// service was down, so updates resume after a restart without loss or replay.
export class TelegramBot extends Context.Service<
	TelegramBot,
	{
		// New messages, oldest first. One consumer only.
		readonly messages: Stream.Stream<TelegramMessage>;
		// Stops of drafts, as they come; each subscriber gets every one.
		readonly draftStops: Stream.Stream<DraftStop>;
		// Returns the id of the new message.
		readonly sendText: (chatId: number, text: string, options?: SendOptions) => Effect.Effect<number, CallError>;
		// Sends the message unless one with the same key was sent already (`randomIdOf`).
		readonly sendOnce: (chatId: number, text: string, key: string, options?: SendOptions) => Effect.Effect<void, CallError>;
		// Shows the text as a draft answer with a stop button; the same draft id updates the same draft.
		readonly sendDraft: (chatId: number, topicId: number | null, draftId: Long, text: string) => Effect.Effect<void, CallError>;
		// Returns the new topic's id.
		readonly createTopic: (chatId: number, title: string) => Effect.Effect<number, CallError>;
		readonly editTopic: (chatId: number, topicId: number, title: string) => Effect.Effect<void, CallError>;
		// A topic already gone is fine.
		readonly deleteTopic: (chatId: number, topicId: number) => Effect.Effect<void, CallError>;
		// Those of the topics that exist.
		readonly existingTopics: (chatId: number, topicIds: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<number>, CallError>;
		readonly download: (fileId: string) => Effect.Effect<Uint8Array, CallError>;
	}
>()('sapphire-agent/TelegramBot') {
	static readonly layer = Layer.effect(
		TelegramBot,
		Effect.gen(function* () {
			const { env } = yield* AppConfig;
			const { botToken, apiId, apiHash } = yield* TelegramConfig;
			const received = yield* Queue.unbounded<TelegramMessage>();
			const stops = yield* PubSub.unbounded<DraftStop>();
			const runFork = Effect.runForkWith(yield* Effect.context<never>());
			const client = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new TelegramClient({
							apiId,
							apiHash: Redacted.value(apiHash),
							storage: new BaseSqliteStorage(new NodeSqliteStorageDriver(join(env.stateDirectory, 'telegram.session'))),
							updates: { catchUp: true },
							logLevel: LogManager.WARN,
						}),
				),
				(created) => Effect.promise(() => created.destroy()),
			);

			client.onError.add((error) => runFork(Effect.logError('Telegram client failed', Cause.fail(error))));
			// Added before the login, which starts the updates loop and its catch-up.
			client.onNewMessage.add((message) => Queue.offerUnsafe(received, toTelegramMessage(message)));
			// Telegram does not document how a draft's stop reaches the bot; a stop typing action from the user is the
			// counterpart of the draft's own.
			client.onRawUpdate.add(({ update }) => {
				if (update._ === 'updateUserTyping' && update.action._ === 'sendMessageStopDraftAction') {
					PubSub.publishUnsafe(stops, { chatId: update.userId, topicId: update.topMsgId ?? null, draftId: update.action.randomId });
				}
			});

			const me = yield* Effect.tryPromise({ try: () => client.start({ botToken: Redacted.value(botToken) }), catch: callFailure('log in as the bot') }).pipe(
				withCallPolicy(callTimeouts.telegram),
			);

			yield* Effect.log(`logged in to Telegram as @${me.username ?? me.id}`);

			const write = <A>(what: string, call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: callFailure(what) }).pipe(withWritePolicy(callTimeouts.telegram));

			// Telegram refuses a write that is done already with these; the write's effect is there either way.
			const alreadyDone =
				(...texts: ReadonlyArray<string>) =>
				<A, R>(effect: Effect.Effect<A, CallError, R>) =>
					effect.pipe(Effect.catchIf((error) => error._tag === 'Permanent' && texts.some((text) => error.message.endsWith(` ${text}`)), () => Effect.void));

			const sendParams = ({ replyTo, topicId }: SendOptions = {}) => ({ replyTo, threadId: topicId });

			return TelegramBot.of({
				messages: Stream.fromQueue(received),
				draftStops: Stream.fromPubSub(stops),
				sendText: (chatId, text, options) => write('send a message', () => client.sendText(chatId, text, sendParams(options))).pipe(Effect.map((message) => message.id)),
				sendOnce: (chatId, text, key, options) =>
					write('send a message', () => client.sendText(chatId, text, { ...sendParams(options), randomId: randomIdOf(key) })).pipe(Effect.asVoid, alreadyDone('RANDOM_ID_DUPLICATE')),
				sendDraft: (chatId, topicId, draftId, text) =>
					write('show a draft', async () =>
						client.call({
							_: 'messages.setTyping',
							peer: await client.resolvePeer(chatId),
							topMsgId: topicId ?? undefined,
							action: { _: 'sendMessageTextDraftAction', canStop: true, randomId: draftId, text: { _: 'textWithEntities', text, entities: [] } },
						}),
					).pipe(Effect.asVoid),
				createTopic: (chatId, title) =>
					write('create a topic', () => client.createForumTopic({ chatId, title })).pipe(
						// For a bot's private chat the service message's own id is in the bot's id space; the topic id is the thread's.
						Effect.flatMap((message) => {
							const topicId = message.replyToMessage?.threadId;

							return topicId === undefined || topicId === null ? Effect.fail(new Permanent({ message: 'Telegram created a topic without a topic id' })) : Effect.succeed(topicId);
						}),
					),
				editTopic: (chatId, topicId, title) => write('rename a topic', () => client.editForumTopic({ chatId, topicId, title })).pipe(Effect.asVoid, alreadyDone('TOPIC_NOT_MODIFIED')),
				deleteTopic: (chatId, topicId) => write('delete a topic', () => client.deleteForumTopicHistory(chatId, topicId)).pipe(alreadyDone('TOPIC_ID_INVALID', 'MESSAGE_ID_INVALID')),
				existingTopics: (chatId, topicIds) =>
					Effect.tryPromise({ try: () => client.getForumTopicsById(chatId, [...topicIds]), catch: callFailure('look up topics') }).pipe(
						withCallPolicy(callTimeouts.telegram),
						// A deleted topic comes back as none.
						Effect.map((topics) => topics.flatMap((topic) => (topic === null ? [] : [topic.id]))),
					),
				download: (fileId) => Effect.tryPromise({ try: () => client.downloadAsBuffer(fileId), catch: callFailure('download a file') }).pipe(withCallPolicy(callTimeouts.telegram)),
			});
		}),
	);
}
