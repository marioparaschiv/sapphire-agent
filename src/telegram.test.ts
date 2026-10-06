import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Logger, Stream } from 'effect';
import { Chat } from './chat.ts';
import { AppConfig } from './config.ts';
import { telegramChat } from './telegram.ts';
import { FakeTelegram } from './telegram-fake.ts';

const layer = telegramChat.pipe(Layer.provide(FakeTelegram.bot), Layer.provideMerge(FakeTelegram.layer), Layer.provideMerge(AppConfig.layerTest('/tmp/sapphire-agent-test')));

const stranger = 6_200_300_400;

describe('telegramChat', () => {
	it.effect('lets through each main-chat text message of an allowed user, normalized, and drops and logs everything else', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const [allowed] = (yield* AppConfig).telegram.allowedUserIds;
			const first = telegram.write({ from: allowed, text: 'hello' });

			telegram.write({ from: stranger, text: 'let me in' });
			telegram.write({ from: allowed, text: 'in a group', groupChatId: -1_001_234 });
			telegram.write({ from: allowed, text: 'in a topic', topicId: 42 });
			telegram.write({ from: allowed });

			const reply = telegram.write({ from: allowed, text: 'and this', replyTo: first });
			const logs: Array<{ level: string; message: unknown }> = [];
			const logger = Logger.map(Logger.formatStructured, (line) => {
				logs.push(line);
			});
			const received = yield* chat.inbound.pipe(Stream.take(2), Stream.runCollect, Effect.provide(Logger.layer([logger])));

			assert.deepStrictEqual(received, [
				{ ref: `${allowed}:${first}`, conversation: { _tag: 'main' }, text: 'hello', replyTo: null },
				{ ref: `${allowed}:${reply}`, conversation: { _tag: 'main' }, text: 'and this', replyTo: `${allowed}:${first}` },
			]);
			assert.deepStrictEqual(
				logs.map(({ level, message }) => ({ level, message })),
				[
					{ level: 'WARN', message: `dropped a Telegram message from user ${stranger}, who is not in telegram.allowedUserIds` },
					{ level: 'WARN', message: 'dropped a Telegram message in group -1001234; only the private chat with the bot is read' },
					{ level: 'WARN', message: 'dropped a Telegram message in a topic, which belongs to no conversation' },
					{ level: 'WARN', message: 'dropped a Telegram message without text' },
				],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('replies in the chat of the message it answers', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const [allowed] = (yield* AppConfig).telegram.allowedUserIds;
			const message = telegram.write({ from: allowed, text: 'hello' });

			yield* chat.send({ _tag: 'reply', to: `${allowed}:${message}`, text: 'Got it.' });

			assert.deepStrictEqual(telegram.sent, [{ chatId: allowed, text: 'Got it.', replyToMessageId: message }]);
		}).pipe(Effect.provide(layer)),
	);
});
