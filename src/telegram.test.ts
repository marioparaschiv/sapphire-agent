import { assert, describe, it } from '@effect/vitest';
import { type Cause, Effect, Exit, Fiber, Layer, Logger, Queue, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { Chat } from './chat.ts';
import { AppConfig } from './config.ts';
import { telegramChat } from './telegram.ts';
import { FakeTelegram } from './telegram-fake.ts';
import { Transcriber } from './transcription.ts';

const chatWith = (config: Layer.Layer<AppConfig>) =>
	telegramChat.pipe(
		Layer.provide(FakeTelegram.bot),
		Layer.provide(Transcriber.layerTest),
		Layer.provideMerge(FakeTelegram.layer),
		Layer.provideMerge(config),
	);

const layer = chatWith(AppConfig.layerTest('/tmp/sapphire-agent-test'));

const twoUsersLayer = chatWith(
	AppConfig.layerTest('/tmp/sapphire-agent-test', {
		telegram: {
			botTokenFile: '/tmp/sapphire-agent-test/telegram-bot-token',
			apiIdFile: '/tmp/sapphire-agent-test/telegram-api-id',
			apiHashFile: '/tmp/sapphire-agent-test/telegram-api-hash',
			allowedUserIds: [7_100_200_300, 7_100_200_301],
		},
	}),
);

const stranger = 6_200_300_400;

const encode = (text: string) => new TextEncoder().encode(text);

// What the messages logged, without the rest of each log line.
const collectLogs = () => {
	const logs: Array<{ level: string; message: unknown }> = [];
	const logger = Logger.map(Logger.formatStructured, ({ level, message }) => {
		logs.push({ level, message });
	});

	return { logs, layer: Logger.layer([logger]) };
};

const allowedUser = AppConfig.useSync((config) => config.telegram.allowedUserIds[0]);

describe('telegramChat', () => {
	it.effect('lets through each text message of an allowed user, in the main chat or a topic, normalized, and drops and logs everything else', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const first = telegram.write({ from: allowed, text: 'hello' });

			telegram.write({ from: stranger, text: 'let me in' });
			telegram.write({ from: allowed, text: 'in a group', groupChatId: -1_001_234 });
			telegram.write({ from: allowed });

			const reply = telegram.write({ from: allowed, text: 'and this', replyTo: first });
			const inTopic = telegram.write({ from: allowed, text: 'in a topic', topicId: 42 });
			const { logs, layer: logged } = collectLogs();
			const received = yield* chat.inbound.pipe(Stream.take(3), Stream.runCollect, Effect.provide(logged));

			assert.deepStrictEqual(received, [
				{ ref: `${allowed}:${first}`, conversation: { _tag: 'main' }, text: 'hello', replyTo: null },
				{ ref: `${allowed}:${reply}`, conversation: { _tag: 'main' }, text: 'and this', replyTo: `${allowed}:${first}` },
				{ ref: `${allowed}:${inTopic}:42`, conversation: { _tag: 'thread', thread: `${allowed}:42` }, text: 'in a topic', replyTo: null },
			]);
			assert.deepStrictEqual(logs, [
				{ level: 'WARN', message: `dropped a Telegram message from user ${stranger}, who is not in telegram.allowedUserIds` },
				{ level: 'WARN', message: 'dropped a Telegram message in group -1001234; only the private chat with the bot is read' },
				{ level: 'WARN', message: 'dropped a Telegram message without text' },
			]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('answers a voice note with its transcript and passes the transcript on as the message, in the main chat or a topic, keeping what it replies to', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;

			yield* chat.send({ _tag: 'reply', to: `${allowed}:${telegram.write({ from: allowed, text: 'hello' })}`, text: 'Hi.' });

			const answered = telegram.sent[0].messageId;
			const thread = yield* chat.openEpic({ identifier: 'HL-12', title: 'Voice notes' }, 'working');
			const topicId = Number(thread.split(':')[1]);
			const voice = telegram.write({ from: allowed, voice: encode('Start HL-12, please.'), replyTo: answered });
			const inTopic = telegram.write({ from: allowed, voice: encode('How far along is it?'), topicId });
			const received = yield* chat.inbound.pipe(Stream.drop(1), Stream.take(2), Stream.runCollect);

			assert.deepStrictEqual(received, [
				{ ref: `${allowed}:${voice}`, conversation: { _tag: 'main' }, text: 'Start HL-12, please.', replyTo: `${allowed}:${answered}` },
				{ ref: `${allowed}:${inTopic}:${topicId}`, conversation: { _tag: 'thread', thread }, text: 'How far along is it?', replyTo: null },
			]);
			assert.deepStrictEqual(
				telegram.sent.slice(1).map(({ text, replyToMessageId, topicId }) => ({ text, replyToMessageId, topicId })),
				[
					{ text: '🎙 Start HL-12, please.', replyToMessageId: voice, topicId: null },
					{ text: '🎙 How far along is it?', replyToMessageId: inTopic, topicId },
				],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('answers a voice note it cannot transcribe with the cause, and passes nothing on', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const voice = telegram.write({ from: allowed, voice: new Uint8Array() });
			const next = telegram.write({ from: allowed, text: 'typed instead' });
			const [received] = yield* chat.inbound.pipe(Stream.take(1), Stream.runCollect);

			assert.strictEqual(received.ref, `${allowed}:${next}`);
			assert.deepStrictEqual(
				telegram.sent.map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[{ text: 'Could not transcribe the voice note: no speech recognized', replyToMessageId: voice }],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('replies in the chat of the message it answers', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const second = yield* AppConfig.useSync((config) => config.telegram.allowedUserIds[1]);
			const message = telegram.write({ from: second, text: 'hello' });

			yield* chat.send({ _tag: 'reply', to: `${second}:${message}`, text: 'Got it.' });

			assert.deepStrictEqual(
				telegram.sent.map(({ chatId, text, replyToMessageId }) => ({ chatId, text, replyToMessageId })),
				[{ chatId: second, text: 'Got it.', replyToMessageId: message }],
			);
		}).pipe(Effect.provide(twoUsersLayer)),
	);

	it.effect('shows an epic as a topic named by its state, posts its PR there and in the main chat once, sums it up in the archive and deletes the topic', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const epic = { identifier: 'HL-40', title: 'Talk to sapphire-agent in Telegram' };

			telegram.write({ from: allowed, text: 'hello' });

			const thread = yield* chat.openEpic(epic, 'working');

			assert.deepStrictEqual(
				telegram.topics().map(({ title }) => title),
				['🟢 HL-40 Talk to sapphire-agent in Telegram'],
			);

			yield* chat.send({ _tag: 'epicState', thread, epic, state: 'awaitingInput' });
			// Sent again after a crash.
			yield* chat.send({ _tag: 'epicState', thread, epic, state: 'awaitingInput' });
			assert.deepStrictEqual(
				telegram.topics().map(({ title }) => title),
				['⏸ HL-40 Talk to sapphire-agent in Telegram'],
			);

			const pullRequestOpened = { _tag: 'pullRequestOpened', thread, epic, url: 'https://github.com/test/repo/pull/7' } as const;

			yield* chat.send(pullRequestOpened);
			yield* chat.send(pullRequestOpened);

			const archive = yield* chat.openArchive;
			const shipped = { _tag: 'epicShipped', archive, epic, pullRequestUrl: 'https://github.com/test/repo/pull/7', slices: 3 } as const;

			yield* chat.send(shipped);
			yield* chat.send(shipped);
			yield* chat.send({ _tag: 'closeThread', thread });
			yield* chat.send({ _tag: 'closeThread', thread });

			const [topicId, archiveId] = [thread, archive].map((ref) => Number(ref.split(':')[1]));

			assert.deepStrictEqual(
				telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[
					{ text: 'PR opened: https://github.com/test/repo/pull/7', topicId },
					{ text: 'HL-40 Talk to sapphire-agent in Telegram: PR opened https://github.com/test/repo/pull/7', topicId: null },
					{ text: 'HL-40 Talk to sapphire-agent in Telegram · https://github.com/test/repo/pull/7 · 3 slices', topicId: archiveId },
				],
			);
			assert.deepStrictEqual(telegram.topics(), [{ chatId: allowed, topicId: archiveId, title: '✅ Done' }]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('streams a reply as a draft and keeps it as a message once the text ends', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'hello' });
			const pieces = yield* Queue.unbounded<string, Cause.Done>();
			const reply = yield* Effect.forkChild(chat.streamReply(`${allowed}:${message}`, Stream.fromQueue(pieces)));

			yield* Queue.offer(pieces, 'Hel');
			yield* Queue.offer(pieces, 'lo');
			yield* TestClock.adjust('1500 millis');
			yield* Queue.offer(pieces, ' there.');
			yield* TestClock.adjust('1500 millis');
			// Nothing new: no draft update.
			yield* TestClock.adjust('1500 millis');
			yield* Queue.end(pieces);

			const refs = yield* Fiber.join(reply);

			assert.deepStrictEqual(
				telegram.drafts.map(({ text }) => text),
				['Hello', 'Hello there.'],
			);
			assert.strictEqual(new Set(telegram.drafts.map(({ draftId }) => draftId)).size, 1);
			assert.deepStrictEqual(
				telegram.sent.map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[{ text: 'Hello there.', replyToMessageId: message }],
			);
			assert.deepStrictEqual(refs, [`${allowed}:${telegram.sent[0].messageId}`]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('stops streaming when the user presses stop, ending the text, and keeps what was written', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'write an essay' });
			let ended: Exit.Exit<unknown, unknown> | null = null;
			const text = Stream.concat(Stream.make('Once upon', ' a time'), Stream.never).pipe(
				Stream.onExit((exit) =>
					Effect.sync(() => {
						ended = exit;
					}),
				),
			);
			const reply = yield* Effect.forkChild(chat.streamReply(`${allowed}:${message}`, text));

			yield* TestClock.adjust('1500 millis');
			yield* telegram.awaitDrafts(1);
			yield* telegram.stopDraft;

			const refs = yield* Fiber.join(reply);

			assert.isTrue(ended !== null && Exit.hasInterrupts(ended));
			assert.deepStrictEqual(
				telegram.sent.map(({ text }) => text),
				['Once upon a time'],
			);
			assert.lengthOf(refs, 1);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('keeps a reply longer than one message as several, the first answering the message', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'list everything' });
			const refs = yield* chat.streamReply(`${allowed}:${message}`, Stream.make('a'.repeat(4096), 'b'.repeat(10)));

			assert.deepStrictEqual(
				telegram.sent.map(({ text, replyToMessageId }) => ({ length: text.length, replyToMessageId })),
				[
					{ length: 4096, replyToMessageId: message },
					{ length: 10, replyToMessageId: null },
				],
			);
			assert.lengthOf(refs, 2);
		}).pipe(Effect.provide(layer)),
	);
});
