import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Scope } from 'effect';
import { AppConfig } from './config.ts';
import { acknowledgement, answerChatMessages } from './conversations.ts';
import { telegramChat } from './telegram.ts';
import { FakeTelegram } from './telegram-fake.ts';

const chat = telegramChat.pipe(Layer.provide(FakeTelegram.bot));

const layer = FakeTelegram.layer.pipe(Layer.provideMerge(AppConfig.layerTest('/tmp/sapphire-agent-test')));

// Answers chat messages, as the service does, until the returned scope (or the test's) is closed: a process start and
// stop.
const start = Effect.gen(function* () {
	const scope = yield* Scope.make();

	yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
	yield* answerChatMessages.pipe(Effect.provide(chat), Effect.forkIn(scope));

	return scope;
});

describe('answerChatMessages', () => {
	it.effect('acknowledges a main-chat message of an allowed user and leaves a stranger unanswered', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const [allowed] = (yield* AppConfig).telegram.allowedUserIds;

			yield* start;
			telegram.write({ from: 6_200_300_400, text: 'let me in' });

			const message = telegram.write({ from: allowed, text: 'hello' });

			yield* telegram.awaitSent(1);

			assert.deepStrictEqual(telegram.sent, [{ chatId: allowed, text: acknowledgement, replyToMessageId: message }]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('after a restart, answers what was written while it was down, and nothing twice', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const [allowed] = (yield* AppConfig).telegram.allowedUserIds;
			const first = yield* start;
			const one = telegram.write({ from: allowed, text: 'one' });

			yield* telegram.awaitSent(1);
			yield* Scope.close(first, Exit.void);

			const two = telegram.write({ from: allowed, text: 'two' });

			yield* start;

			const three = telegram.write({ from: allowed, text: 'three' });

			yield* telegram.awaitSent(3);

			assert.deepStrictEqual(
				telegram.sent.map(({ replyToMessageId }) => replyToMessageId),
				[one, two, three],
			);
		}).pipe(Effect.provide(layer)),
	);
});
