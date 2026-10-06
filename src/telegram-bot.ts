import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
	BaseSqliteStorage,
	BaseSqliteStorageDriver,
	type ISqliteDatabase,
	type Message,
	MtcuteError,
	MtTimeoutError,
	TelegramClient,
	tl,
} from '@mtcute/node';
import { LogManager } from '@mtcute/node/utils.js';
import { Cause, Context, Duration, Effect, Layer, Queue, Redacted, Stream } from 'effect';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy, withWritePolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';

// A new message the bot can see, reduced to what the Telegram Chat adapter reads.
export type TelegramMessage = {
	readonly messageId: number;
	readonly chatId: number;
	// `private` for a chat with one user; otherwise the group or channel kind.
	readonly chatType: string;
	readonly senderId: number;
	// Empty for a message without text, e.g. a sticker.
	readonly text: string;
	readonly isTopicMessage: boolean;
	readonly replyToMessageId: number | null;
};

const toTelegramMessage = (message: Message): TelegramMessage => ({
	messageId: message.id,
	chatId: message.chat.id,
	chatType: message.chat.type === 'user' ? 'private' : message.chat.chatType,
	senderId: message.sender.id,
	text: message.text,
	isTopicMessage: message.isTopicMessage,
	replyToMessageId: message.replyToMessage?.id ?? null,
});

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

// The bot's MTProto client (mtcute), logged in with the bot token for as long as the layer lives. mtcute keeps its
// session and update state in `telegram.session` in the state directory, and catches up on what was sent while the
// service was down, so updates resume after a restart without loss or replay.
export class TelegramBot extends Context.Service<
	TelegramBot,
	{
		// New messages, oldest first. One consumer only.
		readonly messages: Stream.Stream<TelegramMessage>;
		readonly sendText: (chatId: number, text: string, replyToMessageId: number) => Effect.Effect<void, CallError>;
	}
>()('sapphire-agent/TelegramBot') {
	static readonly layer = Layer.effect(
		TelegramBot,
		Effect.gen(function* () {
			const { telegramBotToken, telegramApiId, telegramApiHash, env } = yield* AppConfig;
			const received = yield* Queue.unbounded<TelegramMessage>();
			const runFork = Effect.runForkWith(yield* Effect.context<never>());
			const client = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new TelegramClient({
							apiId: telegramApiId,
							apiHash: Redacted.value(telegramApiHash),
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

			const me = yield* Effect.tryPromise({ try: () => client.start({ botToken: Redacted.value(telegramBotToken) }), catch: callFailure('log in as the bot') }).pipe(
				withCallPolicy(callTimeouts.telegram),
			);

			yield* Effect.log(`logged in to Telegram as @${me.username ?? me.id}`);

			return TelegramBot.of({
				messages: Stream.fromQueue(received),
				sendText: (chatId, text, replyToMessageId) =>
					Effect.tryPromise({ try: () => client.sendText(chatId, text, { replyTo: replyToMessageId }), catch: callFailure('send a message') }).pipe(
						Effect.asVoid,
						withWritePolicy(callTimeouts.telegram),
					),
			});
		}),
	);
}
