import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Clock, Duration, Effect, FiberMap, Option, Schedule, Stream } from 'effect';
import { Chat, type InboundMessage, type ThreadRef } from './chat.ts';
import { ClaudeChat } from './claude-chat.ts';
import { cacheExpiryNotice, describeMismatch, readCacheRefreshDelay, readClaudeSettings, type SettingsMismatch, settingsMismatches } from './claude-settings.ts';
import { itemList } from './comments.ts';
import { type ChatSession, Journal, type ProjectSettings } from './journal.ts';
import { acceptsMessages } from './observation.ts';
import { Projects } from './projects.ts';
import { Reconciler } from './reconciler.ts';

export const unknownContext = "I can't tell which conversation that message continues.\nReply to one of my answers, or send a new message.";

const emptyAnswer = 'Claude answered without any text.\nSend the message again.';

export const notRunning = (identifier: string) => `${identifier} isn't running, so this message went nowhere.\nStart it again to talk to its agent.`;

export const cacheReminder = "⏳ This chat's cache expires in 5 min.\nReply here to keep going.";

// How long after a session's last turn its prompt cache is about to expire; none, with a warning, when that is not
// known or too short to act on.
const cacheRefreshDelay = (without: string) =>
	readCacheRefreshDelay.pipe(
		Effect.tap(Option.match({ onNone: () => Effect.logWarning(`settings.json's promptCacheTtl is not 1h, so ${without}`), onSome: () => Effect.void })),
		Effect.catch((error) => Effect.logWarning(`cannot read promptCacheTtl from settings.json, so ${without}`, error).pipe(Effect.as(Option.none<Duration.Duration>()))),
	);

type ProjectTopic = { readonly thread: ThreadRef; readonly project: ProjectSettings };

// Core's side of the chat, until interrupted. Each message in the main chat or in a project's thread is one Claude
// turn, its reply streamed back; turns run concurrently. A reply continues the session of the bot message it replies
// to, forked, so every bot message keeps its own context; a message that replies to nothing starts a new session, in
// the home directory or the project's repo. A message in an epic's thread is typed into its run's agent, as `ctl.sh
// send` does; with no run to take it, it gets a one-line answer. A failed turn or answer is logged.
//
// A project's thread gets no keep-alive: shortly before the prompt cache of its newest session expires, the bot says so
// once, in a reply that continues the session. A new turn in the thread starts the wait again.
export const answerChatMessages = Effect.scoped(
	Effect.gen(function* () {
		const chat = yield* Chat;
		const journal = yield* Journal;
		const claude = yield* ClaudeChat;
		const reconciler = yield* Reconciler;
		const projects = yield* Projects;
		const refreshDelay = yield* cacheRefreshDelay('project threads get no reminder before their cache expires');
		const reminders = yield* FiberMap.make<ThreadRef>();

		// Nothing when the thread's newest bot message is a reminder already, or its cache expired, e.g. while the service
		// was down.
		const remind = (thread: ThreadRef, delay: Duration.Duration) =>
			Effect.gen(function* () {
				const last = yield* journal.lastChatMessage(thread);

				if (Option.isNone(last) || last.value.kind === 'reminder') {
					return;
				}

				const { messageRef, sessionId, cwd, createdAt } = last.value;
				const due = createdAt + Duration.toMillis(delay);
				const now = yield* Clock.currentTimeMillis;

				if (now >= due + Duration.toMillis(cacheExpiryNotice)) {
					return;
				}

				yield* Effect.sleep(Duration.millis(Math.max(0, due - now)));

				const sent = yield* chat.streamReply(messageRef, Stream.make(cacheReminder));

				yield* journal.addChatSession(sent, { sessionId, cwd, thread, kind: 'reminder' });
			}).pipe(Effect.catch((error) => Effect.logError("cannot remind of a project thread's expiring cache", error)));

		// Replaces the thread's waiting reminder.
		const scheduleReminder = (thread: ThreadRef) =>
			Option.match(refreshDelay, { onNone: () => Effect.void, onSome: (delay) => FiberMap.run(reminders, thread, remind(thread, delay)).pipe(Effect.asVoid) });

		const turn = (message: InboundMessage, topic: ProjectTopic | null) =>
			Effect.gen(function* () {
				const parent = message.replyTo === null ? Option.none<ChatSession>() : yield* journal.chatSession(message.replyTo);

				if (message.replyTo !== null && Option.isNone(parent)) {
					return yield* chat.send({ _tag: 'reply', to: message.ref, text: unknownContext });
				}

				const sessionId = randomUUID();
				const cwd = Option.match(parent, { onNone: () => topic?.project.repo ?? homedir(), onSome: (session) => session.cwd });
				const text = claude
					.turn({ sessionId, parent: Option.map(parent, (session) => session.sessionId), prompt: message.text, cwd, project: topic?.project ?? null })
					.pipe(
						Stream.orElseIfEmpty(() => Stream.make(emptyAnswer)),
						Stream.catch((error) => Effect.logWarning('the chat turn failed', error).pipe(Effect.as(`\n\n${error.message}`), Stream.fromEffect)),
					);
				const sent = yield* chat.streamReply(message.ref, text);

				yield* journal.addChatSession(sent, { sessionId, cwd, thread: topic?.thread ?? null, kind: 'turn' });

				if (topic !== null) {
					yield* scheduleReminder(topic.thread);
				}
			}).pipe(Effect.catch((error) => Effect.logError('cannot answer a chat message', error)));

		const pass = (message: InboundMessage, thread: string) =>
			Effect.gen(function* () {
				const topic = (yield* journal.listTopics).find((candidate) => candidate.thread === thread);

				if (topic === undefined) {
					return yield* Effect.logWarning('dropped a chat message in a thread that belongs to no epic or project');
				}

				if (!Option.exists(yield* journal.getRun(topic.epicId), acceptsMessages)) {
					return yield* chat.send({ _tag: 'reply', to: message.ref, text: notRunning(topic.identifier) });
				}

				yield* journal.addRequest({ _tag: 'send', identifier: topic.identifier, text: message.text });
				yield* Effect.log(`passed a chat message on to ${topic.identifier}'s run`);
				yield* reconciler.wake;
			}).pipe(Effect.catch((error) => Effect.logError('cannot pass a chat message on to its run', error)));

		const answer = (message: InboundMessage) =>
			Effect.gen(function* () {
				if (message.conversation._tag === 'main') {
					return yield* turn(message, null);
				}

				const { thread } = message.conversation;
				const project = (yield* projects.list).find((candidate) => candidate.thread === thread);

				return yield* project === undefined ? pass(message, thread) : turn(message, { thread, project });
			});

		yield* Effect.forEach(yield* projects.list, ({ thread }) => (thread === null ? Effect.void : scheduleReminder(thread)), { discard: true });

		return yield* chat.inbound.pipe(
			Stream.mapEffect(answer, { concurrency: 'unbounded' }),
			Stream.runDrain,
		);
	}),
);

// Keeps the prompt cache of the main chat's newest bot message's session warm, shortly before it would expire, for as
// long as the service runs, so a reply to it after a pause does not pay for its whole context again.
export const keepChatSessionWarm = Effect.gen(function* () {
	const journal = yield* Journal;
	const claude = yield* ClaudeChat;
	const refreshDelay = yield* cacheRefreshDelay('the main chat gets no keep-alive');

	if (Option.isNone(refreshDelay)) {
		return;
	}

	const warm = journal.latestChatSession.pipe(
		Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: claude.keepAlive })),
		Effect.catch((error) => Effect.logWarning('cannot keep the chat session warm; trying again later', error)),
	);

	// Fixed, not spaced: a slow keep-alive turn does not push the next one back.
	return yield* Effect.schedule(warm, Schedule.fixed(refreshDelay.value));
});

const settingsNotice = (mismatches: ReadonlyArray<SettingsMismatch>) =>
	[
		"⚠️ **Chat Claude doesn't run with your settings**",
		...itemList(mismatches.map(({ key, configured, reported }) => `${key}: \`${reported}\`, settings say \`${configured}\``)),
		'Next: fix settings.json, or what overrides it for `claude -p`.',
	].join('\n');

// Starts one chat turn's Claude, kills it once it said what it runs with, and compares that with the user's settings.
// Each mismatch is logged, and they are posted in the main chat together.
export const checkChatSettings = Effect.gen(function* () {
	const claude = yield* ClaudeChat;
	const chat = yield* Chat;
	const { settings, mcpServers } = yield* readClaudeSettings;
	const mismatches = settingsMismatches(settings, mcpServers, yield* claude.init);

	if (mismatches.length === 0) {
		return yield* Effect.log("chat turns run with the user's Claude settings");
	}

	yield* Effect.forEach(mismatches, (mismatch) => Effect.logWarning(describeMismatch(mismatch)), { discard: true });
	yield* chat.send({ _tag: 'notice', thread: null, text: settingsNotice(mismatches), key: null });
});
