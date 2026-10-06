import { readFileSync } from 'node:fs';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { type Cause, Effect, Exit, Fiber, Layer, Logger, Queue, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { Chat } from './chat.ts';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { telegramChat } from './telegram.ts';
import { FakeTelegram } from './telegram-fake.ts';
import { Transcriber } from './transcription.ts';

const chatWith = (config: Layer.Layer<AppConfig>, transcriber: Layer.Layer<Transcriber> = Transcriber.layerTest) =>
	telegramChat.pipe(
		Layer.provide([FakeTelegram.bot, transcriber, NodeFileSystem.layer]),
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

// Transcribes as Transcriber.layerTest does, after five seconds.
const slowTranscriber = Layer.effect(
	Transcriber,
	Effect.gen(function* () {
		const { transcribe } = yield* Transcriber;

		return Transcriber.of({ transcribe: (audio) => Effect.sleep('5 seconds').pipe(Effect.andThen(transcribe(audio))) });
	}),
).pipe(Layer.provide(Transcriber.layerTest));

const slowTranscriptionLayer = chatWith(AppConfig.layerTest('/tmp/sapphire-agent-test'), slowTranscriber);

const stranger = 6_200_300_400;

// Moves the clock one draft tick at a time, so each tick runs before the next.
const ticks = (n: number) => Effect.repeat(TestClock.adjust('1500 millis'), { times: n - 1 });

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
			assert.deepStrictEqual(telegram.typings, []);
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

	it.effect('shows that the bot is typing while it downloads and transcribes a voice note, whether or not that works', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const received = yield* Effect.forkChild(chat.inbound.pipe(Stream.take(1), Stream.runCollect));

			telegram.write({ from: allowed, voice: new Uint8Array() });
			yield* telegram.awaitTypings(1);
			// Typing again at 4.5 s; the transcription fails at 5 s.
			yield* ticks(4);
			yield* telegram.awaitSent(1);

			const topicId = Number((yield* chat.openEpic({ identifier: 'HL-12', title: 'Voice notes' }, 'working')).split(':')[1]);

			telegram.write({ from: allowed, voice: encode('Start HL-12, please.'), topicId });
			yield* telegram.awaitTypings(3);
			yield* ticks(4);

			const [message] = yield* Fiber.join(received);

			yield* ticks(4);
			assert.strictEqual(message.text, 'Start HL-12, please.');
			assert.deepStrictEqual(telegram.typings, [
				{ chatId: allowed, topicId: null },
				{ chatId: allowed, topicId: null },
				{ chatId: allowed, topicId },
				{ chatId: allowed, topicId },
			]);
			assert.deepStrictEqual(
				telegram.sent.map(({ text }) => text),
				["Couldn't transcribe the voice note: no speech recognized\nSend it again, or type it.", '🎙 Start HL-12, please.'],
			);
		}).pipe(Effect.provide(slowTranscriptionLayer)),
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
				[{ text: "Couldn't transcribe the voice note: no speech recognized\nSend it again, or type it.", replyToMessageId: voice }],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('saves a photo to the state directory and passes its path on after the caption, in the main chat or a topic', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			// The bot can open a topic in the user's chat once the user wrote in it.
			const captioned = telegram.write({ from: allowed, text: 'What is wrong here?', photo: encode('screenshot') });
			const thread = yield* chat.openEpic({ identifier: 'HL-12', title: 'Images' }, 'working');
			const topicId = Number(thread.split(':')[1]);
			const inTopic = telegram.write({ from: allowed, photo: encode('another'), topicId });
			const received = yield* chat.inbound.pipe(Stream.take(2), Stream.runCollect);
			const captionedPath = `/tmp/sapphire-agent-test/images/${allowed}-${captioned}.jpg`;
			const inTopicPath = `/tmp/sapphire-agent-test/images/${allowed}-${inTopic}.jpg`;

			assert.deepStrictEqual(received, [
				{ ref: `${allowed}:${captioned}`, conversation: { _tag: 'main' }, text: `What is wrong here?\n\n[Image: ${captionedPath}]`, replyTo: null },
				{ ref: `${allowed}:${inTopic}:${topicId}`, conversation: { _tag: 'thread', thread }, text: `[Image: ${inTopicPath}]`, replyTo: null },
			]);
			assert.strictEqual(readFileSync(captionedPath, 'utf8'), 'screenshot');
			assert.strictEqual(readFileSync(inTopicPath, 'utf8'), 'another');
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

	it.effect('renders the markdown of a notice and a reply as Telegram formatting', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'hello' });
			const thread = yield* chat.openProject('Test');

			yield* chat.send({
				_tag: 'notice',
				thread,
				text: '🔴 **HL-9 stopped**: see [the PR](https://github.com/test/repo/pull/7).\n- Worktree: `/tmp/hl-9`\n```\n**not bold** in a pane\n```\nNext: start over.',
				key: null,
			});
			yield* chat.send({ _tag: 'reply', to: `${allowed}:${message}`, text: 'Run `sapphire status`.' });

			const [notice, reply] = telegram.sent;

			assert.deepStrictEqual(
				[notice.text, notice.topicId],
				['🔴 HL-9 stopped: see the PR.\n- Worktree: /tmp/hl-9\n**not bold** in a pane\nNext: start over.', Number(thread.split(':')[1])],
			);
			assert.deepStrictEqual(
				notice.entities.map((entity) => [entity._, notice.text.slice(entity.offset, entity.offset + entity.length), entity._ === 'messageEntityTextUrl' ? entity.url : null]),
				[
					['messageEntityBold', 'HL-9 stopped', null],
					['messageEntityTextUrl', 'the PR', 'https://github.com/test/repo/pull/7'],
					['messageEntityCode', '/tmp/hl-9', null],
					['messageEntityPre', '**not bold** in a pane', null],
				],
			);
			assert.deepStrictEqual(
				[reply.text, reply.entities.map(({ _ }) => _)],
				['Run sapphire status.', ['messageEntityCode']],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('keeps flags, dunder names and backslashes as written, and sends a reply cut inside a code block unformatted', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'hello' });
			const flags = 'Run sapphire project edit Foo --repo /x --label-repos /y, then edit __init__.py in C:\\src.';
			const cut = 'The diff:\n```\n**not bold**';

			yield* chat.send({ _tag: 'reply', to: `${allowed}:${message}`, text: flags });
			yield* chat.send({ _tag: 'reply', to: `${allowed}:${message}`, text: cut });

			assert.deepStrictEqual(
				telegram.sent.map(({ text, entities }) => [text, entities.length]),
				[
					[flags, 0],
					[cut, 0],
				],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('shows a keyed notice once, also when it is sent again after a crash', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const notice = { _tag: 'notice', thread: null, text: '📦 **Kept HL-9 worktree**', key: 'HL-9:keptWorktree:1000' } as const;

			telegram.write({ from: allowed, text: 'hello' });
			yield* chat.send(notice);
			yield* chat.send(notice);
			yield* chat.send({ ...notice, key: 'HL-9:keptWorktree:2000' });

			assert.deepStrictEqual(
				telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[
					{ text: '📦 Kept HL-9 worktree', topicId: null },
					{ text: '📦 Kept HL-9 worktree', topicId: null },
				],
			);
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

	it.effect('shows a Thinking draft in the topic until text arrives, then the text, showing each again before it expires, and nothing once the reply lands', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;

			telegram.write({ from: allowed, text: 'hello' });

			const topicId = Number((yield* chat.openEpic({ identifier: 'HL-59', title: 'Typing' }, 'working')).split(':')[1]);
			const message = telegram.write({ from: allowed, text: 'what changed?', topicId });
			const pieces = yield* Queue.unbounded<string, Cause.Done>();
			const reply = yield* Effect.forkChild(chat.streamReply(`${allowed}:${message}:${topicId}`, Stream.fromQueue(pieces)));

			yield* telegram.awaitDrafts(1);
			// Thinking again at 4.5 s and 9 s.
			yield* ticks(6);
			yield* telegram.awaitDrafts(3);
			yield* Queue.offer(pieces, 'Hel');
			yield* ticks(1);
			yield* telegram.awaitDrafts(4);
			// The same draft again 4.5 s later.
			yield* ticks(3);
			yield* telegram.awaitDrafts(5);
			yield* Queue.offer(pieces, 'lo');
			yield* ticks(1);
			yield* telegram.awaitDrafts(6);
			yield* Queue.end(pieces);
			yield* Fiber.join(reply);
			yield* ticks(4);

			assert.deepStrictEqual(telegram.typings, []);
			assert.deepStrictEqual(
				telegram.drafts.map(({ topicId, text }) => ({ topicId, text })),
				[
					{ topicId, text: 'Thinking' },
					{ topicId, text: 'Thinking' },
					{ topicId, text: 'Thinking' },
					{ topicId, text: 'Hel' },
					{ topicId, text: 'Hel' },
					{ topicId, text: 'Hello' },
				],
			);
			assert.deepStrictEqual(
				telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[{ text: 'Hello', topicId }],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('shows nothing more once the turn is interrupted', () =>
		Effect.gen(function* () {
			const telegram = yield* FakeTelegram;
			const chat = yield* Chat;
			const allowed = yield* allowedUser;
			const message = telegram.write({ from: allowed, text: 'hello' });
			const reply = yield* Effect.forkChild(chat.streamReply(`${allowed}:${message}`, Stream.never));

			yield* telegram.awaitDrafts(1);
			yield* Fiber.interrupt(reply);
			yield* ticks(4);

			assert.deepStrictEqual(
				telegram.drafts.map(({ text }) => text),
				['Thinking'],
			);
			assert.deepStrictEqual(telegram.sent, []);
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
			const shown = [telegram.typings.length, telegram.drafts.length];

			yield* ticks(4);
			assert.deepStrictEqual([telegram.typings.length, telegram.drafts.length], shown);
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
