import { randomBytes } from 'node:crypto';
import { Long } from '@mtcute/node';
import { Effect, Fiber, Layer, Option, Ref, Result, Schedule, Stream } from 'effect';
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
const draftInterval = '1500 millis';

const stateIcons: Record<EpicState, string> = { working: '🟢', awaitingInput: '⏸', error: '🔴', review: '👀' };

const topicTitle = ({ identifier, title }: EpicHeading, state: EpicState) => `${stateIcons[state]} ${identifier} ${title}`.slice(0, titleLength);

const archiveTitle = '✅ Done';

const sliceIcons: Record<SliceProgress, string> = { started: '▶️', done: '✔️' };

const chunks = (text: string) => Array.from({ length: Math.ceil(text.length / messageLength) }, (_, index) => text.slice(index * messageLength, (index + 1) * messageLength));

// The end of the text, at most `length` characters.
const endOf = (text: string, length: number) => (text.length > length ? `…${text.slice(-(length - 1))}` : text);

// As much of the end of the text as one message shows.
const draftOf = (text: string) => endOf(text, messageLength);

const questionHeading = '⏸ Waiting for input:\n\n';

const questionFooter = '\n\nWrite here to answer; it is typed into the agent.';

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
// streams replies as drafts. Epic topics go to the chat of the first allowed user.
export const telegramChat = Layer.effect(
	Chat,
	Effect.gen(function* () {
		const { telegram } = yield* AppConfig;
		const bot = yield* TelegramBot;
		const transcriber = yield* Transcriber;
		const [userChat] = telegram.allowedUserIds;

		const answer = (message: TelegramMessage, text: string) =>
			bot.sendText(message.chatId, text, { replyTo: message.messageId, topicId: message.topicId ?? undefined }).pipe(
				Effect.catch((error) => Effect.logError('cannot answer a voice note', error)),
			);

		// The transcript is shown as the answer to the voice note, so the user sees what the agent was told.
		const textOf = (message: TelegramMessage, voiceFileId: string | null): Effect.Effect<Option.Option<string>> => {
			if (voiceFileId === null) {
				return Effect.succeed(Option.some(message.text));
			}

			return bot.download(voiceFileId).pipe(
				Effect.flatMap((audio) => transcriber.transcribe(audio)),
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning('cannot transcribe a voice note', error).pipe(
							Effect.andThen(answer(message, `Could not transcribe the voice note: ${error.message}`)),
							Effect.as(Option.none()),
						),
					onSuccess: (transcript) => answer(message, `🎙 ${transcript}`).pipe(Effect.as(Option.some(transcript))),
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
				const shown = yield* Ref.make('');

				const showDraft = Effect.gen(function* () {
					const current = yield* Ref.get(written);

					if (current === '' || current === (yield* Ref.get(shown))) {
						return;
					}

					yield* Ref.set(shown, current);
					yield* bot.sendDraft(chatId, topicId, draftId, draftOf(current)).pipe(Effect.catch((error) => Effect.logWarning('cannot show a draft reply', error)));
				});

				const stopped = bot.draftStops.pipe(
					Stream.filter((stop) => stop.chatId === chatId && stop.topicId === topicId && stop.draftId.equals(draftId)),
					Stream.runHead,
				);
				const drafts = yield* Effect.forkChild(Effect.repeat(Effect.sleep(draftInterval).pipe(Effect.andThen(showDraft)), Schedule.forever));

				yield* Effect.raceFirst(
					Stream.runForEach(text, (piece) => Ref.update(written, (current) => current + piece)),
					stopped,
				);
				yield* Fiber.interrupt(drafts);

				const sent: Array<string> = [];

				for (const [index, chunk] of chunks((yield* Ref.get(written)).trim()).entries()) {
					const id = yield* bot.sendText(chatId, chunk, { replyTo: index === 0 ? messageId : undefined, topicId: topicId ?? undefined });

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

							return yield* bot.sendText(chatId, intent.text, { replyTo: messageId, topicId: topicId ?? undefined }).pipe(Effect.asVoid);
						}

						case 'epicState': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.editTopic(chatId, topicId, topicTitle(intent.epic, intent.state));
						}

						case 'pullRequestOpened': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							yield* bot.sendOnce(chatId, `PR opened: ${intent.url}`, `pullRequestOpened:${intent.thread}:${intent.url}`, { topicId });

							return yield* bot.sendOnce(chatId, `${intent.epic.identifier} ${intent.epic.title}: PR opened ${intent.url}`, `pullRequestOpened:main:${intent.url}`);
						}

						case 'epicShipped': {
							const { chatId, topicId } = yield* parseThreadRef(intent.archive);
							const { identifier, title } = intent.epic;
							const line = [`${identifier} ${title}`, intent.pullRequestUrl ?? 'no PR', `${intent.slices} ${intent.slices === 1 ? 'slice' : 'slices'}`].join(' · ');

							return yield* bot.sendOnce(chatId, line, `epicShipped:${intent.archive}:${identifier}`, { topicId });
						}

						case 'closeThread': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.deleteTopic(chatId, topicId);
						}

						case 'sliceMoved': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);
							const { identifier, title } = intent.slice;

							return yield* bot.sendOnce(chatId, `${sliceIcons[intent.progress]} ${identifier} ${title} ${intent.progress}`, `sliceMoved:${intent.thread}:${identifier}:${intent.progress}`, { topicId });
						}

						case 'phaseStarted': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);

							return yield* bot.sendOnce(chatId, `🔎 /${intent.phase} started`, `phaseStarted:${intent.thread}:${intent.phase}:${intent.startedAt}`, { topicId });
						}

						case 'question': {
							const { chatId, topicId } = yield* parseThreadRef(intent.thread);
							const text = `${questionHeading}${endOf(intent.text, messageLength - questionHeading.length - questionFooter.length)}${questionFooter}`;

							return yield* bot.sendOnce(chatId, text, `question:${intent.thread}:${intent.askedAt}`, { topicId });
						}
					}
				}),
			streamReply,
			openEpic: (epic, state) => openTopic(topicTitle(epic, state)),
			openArchive: openTopic(archiveTitle),
		});
	}),
);
