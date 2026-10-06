import { randomBytes } from 'node:crypto';
import { Long, md, type TextWithEntities } from '@mtcute/node';
import { Clock, Duration, Effect, Fiber, Layer, Option, Ref, Result, Stream } from 'effect';
import { Permanent } from './call-policy.ts';
import { Chat, type EpicHeading, type EpicState, type InboundMessage, type SliceProgress } from './chat.ts';
import { AppConfig } from './config.ts';
import { TelegramBot, type TelegramMessage } from './telegram-bot.ts';
import { Transcriber } from './transcription.ts';

// A MessageRef is `<chat id>:<message id>`, plus `:<topic id>` for a message in a topic. A ThreadRef is
// `<chat id>:<topic id>`.
const messageRef = (chatId: number, messageId: number, topicId: number | null) => (topicId === null ? `${chatId}:${messageId}` : `${chatId}:${messageId}:${topicId}`);

const threadRef = (chatId: number, topicId: number) => `${chatId}:${topicId}`;

const parseIds = (ref: string, count: ReadonlyArray<number>, what: string): Effect.Effect<ReadonlyArray<number>, Permanent> => {
	const ids = ref.split(':').map(Number);

	return count.includes(ids.length) && ids.every(Number.isInteger) ? Effect.succeed(ids) : Effect.fail(new Permanent({ message: `${ref} is not a Telegram ${what}` }));
};

const parseMessageRef = (ref: string) => parseIds(ref, [2, 3], 'message').pipe(Effect.map(([chatId, messageId, topicId]) => ({ chatId, messageId, topicId: topicId ?? null })));

const parseThreadRef = (ref: string) => parseIds(ref, [2], 'topic').pipe(Effect.map(([chatId, topicId]) => ({ chatId, topicId })));

// Telegram's limits: a message holds 4096 characters, a topic title 128.
const messageLength = 4096;

const titleLength = 128;

// setTyping allows 20 calls in 5 s and 40 in 30 s per chat; this leaves room for two replies streaming at once.
export const draftInterval = '1500 millis';

// A typing action, a draft included, shows for a few seconds; one sent again by then keeps it up.
const refreshAfter = Duration.seconds(4);

const stateIcons: Record<EpicState, string> = { working: '🟢', awaitingInput: '⏸', error: '🔴', review: '👀' };

const topicTitle = ({ identifier, title }: EpicHeading, state: EpicState) => `${stateIcons[state]} ${identifier} ${title}`.slice(0, titleLength);

const archiveTitle = '✅ Done';

const projectTitle = (name: string) => `📁 ${name}`.slice(0, titleLength);

const sliceIcons: Record<SliceProgress, string> = { started: '▶️', done: '✔️' };

// Shows what the bot writes, until interrupted: at once, then on each tick when it changed, or again once
// `refreshAfter` passed since it was last shown.
const keepShowing = (written: Effect.Effect<string>, show: (text: string) => Effect.Effect<void>) =>
	Effect.gen(function* () {
		const shown = yield* Ref.make({ text: '', at: 0 });

		const showNow = (text: string) =>
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((at) => Ref.set(shown, { text, at })),
				Effect.andThen(show(text)),
			);

		yield* showNow(yield* written);

		return yield* Effect.forever(
			Effect.sleep(draftInterval).pipe(
				Effect.andThen(
					Effect.gen(function* () {
						const text = yield* written;
						const last = yield* Ref.get(shown);

						if (text !== last.text || (yield* Clock.currentTimeMillis) - last.at >= Duration.toMillis(refreshAfter)) {
							yield* showNow(text);
						}
					}),
				),
			),
		);
	});

const chunks = (text: string) => Array.from({ length: Math.ceil(text.length / messageLength) }, (_, index) => text.slice(index * messageLength, (index + 1) * messageLength));

// The end of the text, at most `length` characters.
const endOf = (text: string, length: number) => (text.length > length ? `…${text.slice(-(length - 1))}` : text);

// The start of the text, at most `length` characters.
const startOf = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// As much of the end of the text as one message shows.
const draftOf = (text: string) => endOf(text, messageLength);

// Text is markdown as Chat documents it. mtcute also reads `--` as underline, `__` as italic and a backslash as an
// escape, which turn up as plain text in commands, names and paths, so those are kept literal. A cut that leaves a code
// block open makes mtcute throw; that text goes out unformatted.
const markdown = (text: string): TextWithEntities => {
	try {
		return md(text.replaceAll('\\', '\\\\').replaceAll('--', '\\-\\-').replaceAll('__', '\\_\\_'));
	} catch {
		return { text, entities: [] };
	}
};

// The code block holds the question, cut to what one message shows besides the rest.
const questionText = (question: string) => md`⏸ **The agent waits for input**\n\`\`\`\n${endOf(question, messageLength - 100)}\n\`\`\`\nWrite here to answer; it is typed into the agent.`;

// Why a message is dropped, or what it is: text, or a voice note to transcribe first.
const accepted = (message: TelegramMessage, allowedUserIds: ReadonlyArray<number>): Result.Result<{ readonly voiceFileId: string | null }, string> => {
	if (!allowedUserIds.includes(message.senderId)) {
		return Result.fail(`dropped a Telegram message from user ${message.senderId}, who is not in telegram.allowedUserIds`);
	}

	if (message.chatType !== 'private') {
		return Result.fail(`dropped a Telegram message in ${message.chatType} ${message.chatId}; only the private chat with the bot is read`);
	}

	if (message.text === '' && message.voiceFileId === null) {
		return Result.fail('dropped a Telegram message without text');
	}

	return Result.succeed({ voiceFileId: message.text === '' ? message.voiceFileId : null });
};

// The Chat port over the Telegram bot. It lets through what an allowed user wrote in their private chat with the bot,
// in the main chat (General) or in a topic, with voice notes transcribed; renders intents as messages and topics; and
// streams replies as drafts. Epic and project topics go to the chat of the first allowed user.
export const telegramChat = Layer.effect(
	Chat,
	Effect.gen(function* () {
		const { telegram } = yield* AppConfig;
		const bot = yield* TelegramBot;
		const transcriber = yield* Transcriber;
		const [userChat] = telegram.allowedUserIds;

		const showTyping = (chatId: number, topicId: number | null) => bot.sendTyping(chatId, topicId).pipe(Effect.catch((error) => Effect.logWarning('cannot show that the bot is typing', error)));

		const answerVoiceNote = (message: TelegramMessage, text: TextWithEntities) =>
			bot.sendText(message.chatId, text, { replyTo: message.messageId, topicId: message.topicId ?? undefined }).pipe(
				Effect.catch((error) => Effect.logError('cannot answer a voice note', error)),
			);

		// The transcript is shown as the answer to the voice note, so the user sees what the agent was told.
		const textOf = (message: TelegramMessage, voiceFileId: string | null): Effect.Effect<Option.Option<string>> => {
			if (voiceFileId === null) {
				return Effect.succeed(Option.some(message.text));
			}

			return Effect.raceFirst(
				bot.download(voiceFileId).pipe(Effect.flatMap((audio) => transcriber.transcribe(audio))),
				Effect.forever(showTyping(message.chatId, message.topicId).pipe(Effect.andThen(Effect.sleep(refreshAfter)))),
			).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning('cannot transcribe a voice note', error).pipe(
							Effect.andThen(answerVoiceNote(message, md`Couldn't transcribe the voice note: ${error.message}\nSend it again, or type it.`)),
							Effect.as(Option.none()),
						),
					onSuccess: (transcript) => answerVoiceNote(message, md`🎙 ${transcript}`).pipe(Effect.as(Option.some(transcript))),
				}),
			);
		};

		const inbound = (message: TelegramMessage): Effect.Effect<Result.Result<InboundMessage, void>> => {
			const result = accepted(message, telegram.allowedUserIds);

			if (Result.isFailure(result)) {
				return Effect.logWarning(result.failure).pipe(Effect.as(Result.failVoid));
			}

			return textOf(message, result.success.voiceFileId).pipe(
				Effect.map(
					Option.match({
						onNone: () => Result.failVoid,
						onSome: (text) =>
							Result.succeed({
								ref: messageRef(message.chatId, message.messageId, message.topicId),
								conversation: message.topicId === null ? { _tag: 'main' } : { _tag: 'thread', thread: threadRef(message.chatId, message.topicId) },
								text,
								replyTo: message.replyToMessageId === null ? null : messageRef(message.chatId, message.replyToMessageId, message.topicId),
							}),
					}),
				),
			);
		};

		const streamReply = (to: string, text: Stream.Stream<string>) =>
			Effect.gen(function* () {
				const { chatId, messageId, topicId } = yield* parseMessageRef(to);
				const draftId = Long.fromBytesBE([...randomBytes(8)]);
				const written = yield* Ref.make('');

				const show = (current: string) =>
					current === ''
						? showTyping(chatId, topicId)
						: bot.sendDraft(chatId, topicId, draftId, markdown(draftOf(current))).pipe(Effect.catch((error) => Effect.logWarning('cannot show a draft reply', error)));

				const stopped = bot.draftStops.pipe(
					Stream.filter((stop) => stop.chatId === chatId && stop.topicId === topicId && stop.draftId.equals(draftId)),
					Stream.runHead,
				);
				const showing = yield* Effect.forkChild(keepShowing(Ref.get(written), show));

				yield* Effect.raceFirst(
					Stream.runForEach(text, (piece) => Ref.update(written, (current) => current + piece)),
					stopped,
				);
				yield* Fiber.interrupt(showing);

				const sent: Array<string> = [];

				for (const [index, chunk] of chunks((yield* Ref.get(written)).trim()).entries()) {
					const id = yield* bot.sendText(chatId, markdown(chunk), { replyTo: index === 0 ? messageId : undefined, topicId: topicId ?? undefined });

					sent.push(messageRef(chatId, id, topicId));
				}

				return sent;
			});

		const openTopic = (title: string) => bot.createTopic(userChat, title).pipe(Effect.map((topicId) => threadRef(userChat, topicId)));

		return Chat.of({
			inbound: bot.messages.pipe(Stream.filterMapEffect(inbound)),
			send: (intent) =>
				Effect.gen(function* () {
					switch (intent._tag) {
						case 'reply': {
							const { chatId, messageId, topicId } = yield* parseMessageRef(intent.to);

							return yield* bot.sendText(chatId, markdown(intent.text), { replyTo: messageId, topicId: topicId ?? undefined }).pipe(Effect.asVoid);
						}

						case 'epicState': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.editTopic(chatId, topicId, topicTitle(intent.epic, intent.state));
						}

						case 'pullRequestOpened': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							yield* bot.sendOnce(chatId, md`PR opened: ${intent.url}`, `pullRequestOpened:${intent.thread}:${intent.url}`, { topicId });

							return yield* bot.sendOnce(chatId, md`${intent.epic.identifier} ${intent.epic.title}: PR opened ${intent.url}`, `pullRequestOpened:main:${intent.url}`);
						}

						case 'epicShipped': {
							const { chatId, topicId } = yield* parseThreadRef(intent.archive);
							const { identifier, title } = intent.epic;
							const line = [`${identifier} ${title}`, intent.pullRequestUrl ?? 'no PR', `${intent.slices} ${intent.slices === 1 ? 'slice' : 'slices'}`].join(' · ');

							return yield* bot.sendOnce(chatId, md`${line}`, `epicShipped:${intent.archive}:${identifier}`, { topicId });
						}

						case 'closeThread': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.deleteTopic(chatId, topicId);
						}

						case 'sliceMoved': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);
							const { identifier, title } = intent.slice;

							return yield* bot.sendOnce(chatId, md`${sliceIcons[intent.progress]} ${identifier} ${title} ${intent.progress}`, `sliceMoved:${intent.thread}:${identifier}:${intent.progress}`, { topicId });
						}

						case 'phaseStarted': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.sendOnce(chatId, md`🔎 /${intent.phase} started`, `phaseStarted:${intent.thread}:${intent.phase}:${intent.startedAt}`, { topicId });
						}

						case 'question': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);
							return yield* bot.sendOnce(chatId, questionText(intent.text), `question:${intent.thread}:${intent.askedAt}`, { topicId });
						}

						case 'notice': {
							const { chatId, topicId } = intent.thread === null ? { chatId: userChat, topicId: undefined } : yield* parseThreadRef(intent.thread);
							const text = markdown(startOf(intent.text, messageLength));

							return yield* intent.key === null ? bot.sendText(chatId, text, { topicId }).pipe(Effect.asVoid) : bot.sendOnce(chatId, text, `notice:${intent.key}`, { topicId });
						}
					}
				}),
			streamReply,
			openEpic: (epic, state) => openTopic(topicTitle(epic, state)),
			openArchive: openTopic(archiveTitle),
			openProject: (name) => openTopic(projectTitle(name)),
			missingThreads: (threads) =>
				Effect.gen(function* () {
					const parsed = yield* Effect.forEach(threads, parseThreadRef);
					const chats = [...new Set(parsed.map(({ chatId }) => chatId))];
					const existing = yield* Effect.forEach(chats, (chatId) =>
						bot.existingTopics(chatId, parsed.filter((thread) => thread.chatId === chatId).map(({ topicId }) => topicId)).pipe(Effect.map((topicIds) => topicIds.map((topicId) => threadRef(chatId, topicId)))),
					);

					return threads.filter((thread) => !existing.flat().includes(thread));
				}),
		});
	}),
);
