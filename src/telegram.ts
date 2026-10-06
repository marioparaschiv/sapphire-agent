import { Effect, Layer, Result, Stream } from 'effect';
import { Permanent } from './call-policy.ts';
import { Chat, type InboundMessage } from './chat.ts';
import { AppConfig } from './config.ts';
import { TelegramBot, type TelegramMessage } from './telegram-bot.ts';

// A MessageRef is `<chat id>:<message id>`.
const messageRef = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

const parseMessageRef = (ref: string) => {
	const [chatId, messageId] = ref.split(':').map(Number);

	return Number.isInteger(chatId) && Number.isInteger(messageId) ? Effect.succeed({ chatId, messageId }) : Effect.fail(new Permanent({ message: `${ref} is not a Telegram message` }));
};

// The message, if an allowed user wrote it in the main chat (General) of their private chat with the bot, or why it is
// dropped.
const inbound = (message: TelegramMessage, allowedUserIds: ReadonlyArray<number>): Result.Result<InboundMessage, string> => {
	if (!allowedUserIds.includes(message.senderId)) {
		return Result.fail(`dropped a Telegram message from user ${message.senderId}, who is not in telegram.allowedUserIds`);
	}

	if (message.chatType !== 'private') {
		return Result.fail(`dropped a Telegram message in ${message.chatType} ${message.chatId}; only the private chat with the bot is read`);
	}

	if (message.isTopicMessage) {
		return Result.fail('dropped a Telegram message in a topic, which belongs to no conversation');
	}

	if (message.text === '') {
		return Result.fail('dropped a Telegram message without text');
	}

	return Result.succeed({
		ref: messageRef(message.chatId, message.messageId),
		conversation: { _tag: 'main' },
		text: message.text,
		replyTo: message.replyToMessageId === null ? null : messageRef(message.chatId, message.replyToMessageId),
	});
};

// The Chat port over the Telegram bot: renders intents as messages and lets through only what an allowed user wrote in
// the main chat.
export const telegramChat = Layer.effect(
	Chat,
	Effect.gen(function* () {
		const { telegram } = yield* AppConfig;
		const bot = yield* TelegramBot;

		return Chat.of({
			inbound: bot.messages.pipe(
				Stream.filterMapEffect((message) => {
					const result = inbound(message, telegram.allowedUserIds);

					return Result.isFailure(result) ? Effect.logWarning(result.failure).pipe(Effect.as(result)) : Effect.succeed(result);
				}),
			),
			send: (intent) =>
				Effect.gen(function* () {
					const { chatId, messageId } = yield* parseMessageRef(intent.to);

					yield* bot.sendText(chatId, intent.text, messageId);
				}),
		});
	}),
);
