import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Logger, Scope, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { ClaudeChat } from './claude-chat.ts';
import { type FakeClaudeAnswer, type FakeClaudeRun, fakeClaude, flagValue } from './claude-chat-fake.ts';
import { AppConfig } from './config.ts';
import { Chat } from './chat.ts';
import { answerChatMessages, cacheReminder, checkChatSettings, keepChatSessionWarm, unknownContext } from './conversations.ts';
import { Journal } from './journal.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Projects } from './projects.ts';
import { Prompts } from './prompts.ts';
import { Reconciler } from './reconciler.ts';
import { telegramChat } from './telegram.ts';
import { FakeTelegram } from './telegram-fake.ts';
import { plannerDependencies } from './test-harness.ts';
import { Transcriber } from './transcription.ts';

// The main chat as the service runs it, over the Telegram fake, a fake `claude` and a journal file in a temp dir.
const makeChat = (answer: (run: FakeClaudeRun) => FakeClaudeAnswer = () => ({ text: ['Sure.'] })) =>
	Effect.gen(function* () {
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), 'sapphire-agent-chat-'))),
			(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
		);
		const config = AppConfig.layerTest(dir);
		const claudeConfigDirectory = join(dir, 'claude');

		mkdirSync(claudeConfigDirectory, { recursive: true });
		writeFileSync(join(claudeConfigDirectory, 'settings.json'), JSON.stringify({ promptCacheTtl: '1h' }));

		const claude = yield* fakeClaude(claudeConfigDirectory, answer);
		const telegram = yield* Layer.build(FakeTelegram.layer);
		const recorded = yield* SubscriptionRef.make(0);
		// Counts the replies whose sessions were recorded, which happens just after they are sent.
		const CountingJournal = Layer.effect(
			Journal,
			Journal.useSync((journal) =>
				Journal.of({ ...journal, addChatSession: (refs, post) => journal.addChatSession(refs, post).pipe(Effect.andThen(SubscriptionRef.update(recorded, (count) => count + 1))) }),
			),
		).pipe(Layer.provide(Journal.layer(join(dir, 'journal.db'))));
		const services = Layer.mergeAll(
			telegramChat.pipe(Layer.provide(FakeTelegram.bot), Layer.provide(Transcriber.layerTest)),
			ClaudeChat.layer.pipe(Layer.provide([claude.layer, Prompts.layer, NodeFileSystem.layer])),
			// Nothing to tick: a main-chat turn never wakes it.
			Reconciler.layer.pipe(Layer.provide(Planner.layer(Effect.succeed([]))), Layer.provide(Pause.layer), Layer.provide([plannerDependencies(dir), NodeFileSystem.layer])),
			Projects.layer,
			NodeFileSystem.layer,
		).pipe(Layer.provideMerge(CountingJournal), Layer.provideMerge(config), Layer.provide(Layer.succeedContext(telegram)));
		const controls = yield* FakeTelegram.pipe(Effect.provide(telegram));

		// Answers chat messages and keeps the session warm, as the service does, until the returned scope closes.
		const start = Effect.gen(function* () {
			const scope = yield* Scope.make();

			yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
			yield* Effect.all([answerChatMessages, keepChatSessionWarm], { concurrency: 'unbounded' }).pipe(Effect.provide(services), Effect.forkIn(scope));

			return scope;
		});

		const [user] = (yield* AppConfig.pipe(Effect.provide(config))).telegram.allowedUserIds;

		const awaitRecorded = (n: number) =>
			SubscriptionRef.changes(recorded).pipe(
				Stream.takeUntil((count) => count >= n),
				Stream.runDrain,
			);

		return { dir, claudeConfigDirectory, claude, telegram: controls, start, services, user, journalFile: join(dir, 'journal.db'), awaitRecorded };
	});

const sessionOf = (run: FakeClaudeRun) => flagValue(run.args, '--session-id');

const parentOf = (run: FakeClaudeRun) => (run.args.includes('--fork-session') ? flagValue(run.args, '--resume') : null);

describe('answerChatMessages', () => {
	it.effect('answers a main-chat message with a reply Claude streams in a new session, and records only which session the reply was written in', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat(() => ({ text: ['Hello', ' there.'] }));

			yield* chat.start;

			const message = chat.telegram.write({ from: chat.user, text: 'hi, who are you?' });

			yield* chat.awaitRecorded(1);

			const [run] = chat.claude.runs;
			const [sent] = chat.telegram.sent;

			assert.deepStrictEqual(
				{ text: sent.text, replyTo: sent.replyToMessageId, prompt: run.prompt, cwd: run.cwd, parent: parentOf(run) },
				{ text: 'Hello there.', replyTo: message, prompt: 'hi, who are you?', cwd: homedir(), parent: null },
			);
			assert.deepStrictEqual(run.args.slice(0, 9), [
				'-p',
				'--output-format',
				'stream-json',
				'--include-partial-messages',
				'--verbose',
				'--setting-sources',
				'user,project,local',
				'--append-system-prompt',
				(yield* Prompts.pipe(Effect.provide(Prompts.layer))).chat,
			]);
			assert.include(run.args[8], 'sapphire start <EPIC-ID>');

			for (const isolating of ['--bare', '--strict-mcp-config', '--system-prompt', '--reply-to']) {
				assert.notInclude(run.args, isolating);
			}

			const database = new DatabaseSync(chat.journalFile, { readOnly: true });
			const rows = database.prepare('SELECT * FROM chat_sessions').all();

			database.close();
			assert.deepStrictEqual(
				rows.map(({ message_ref, session_id }) => ({ message_ref, session_id })),
				[{ message_ref: `${chat.user}:${sent.messageId}`, session_id: sessionOf(run) }],
			);
		}).pipe(Effect.scoped),
	);

	it.effect('continues a reply from the session of the bot message it replies to, forked, so replies to the same message branch independently', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: [`answer to ${run.prompt}`] }));
			const answerTo = (text: string, replyTo?: number) =>
				Effect.gen(function* () {
					chat.telegram.write({ from: chat.user, text, replyTo });
					yield* chat.awaitRecorded(chat.claude.runs.length + 1);

					return chat.telegram.sent.at(-1)?.messageId;
				});

			yield* chat.start;

			const first = yield* answerTo('one');

			yield* answerTo('two');
			yield* answerTo('back to one', first);

			const branch = yield* answerTo('back to one again', first);

			yield* answerTo('deeper', branch);

			const [one, two, back, again, deeper] = chat.claude.runs;

			assert.deepStrictEqual(
				[one, two, back, again, deeper].map(parentOf),
				[null, null, sessionOf(one), sessionOf(one), sessionOf(again)],
			);
			assert.strictEqual(new Set(chat.claude.runs.map(sessionOf)).size, 5);
		}).pipe(Effect.scoped),
	);

	it.effect('answers a voice note with its transcript, then as if it was typed, continuing the session of the bot message it replies to', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: [`answer to ${run.prompt}`] }));

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'what is in flight?' });
			yield* chat.awaitRecorded(1);

			const answered = chat.telegram.sent[0].messageId;
			const voice = chat.telegram.write({ from: chat.user, voice: new TextEncoder().encode('Start HL-12.'), replyTo: answered });

			yield* chat.awaitRecorded(2);

			const [first, spoken] = chat.claude.runs;

			assert.deepStrictEqual(
				chat.telegram.sent.slice(1).map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[
					{ text: '🎙 Start HL-12.', replyToMessageId: voice },
					{ text: 'answer to Start HL-12.', replyToMessageId: voice },
				],
			);
			assert.deepStrictEqual([spoken.prompt, parentOf(spoken)], ['Start HL-12.', sessionOf(first)]);
		}).pipe(Effect.scoped),
	);

	it.effect('answers a reply to a message whose session is unknown with one line, without a turn', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat();

			yield* chat.start;

			const own = chat.telegram.write({ from: chat.user, text: 'a note to self' });

			yield* chat.telegram.awaitSent(1);

			const reply = chat.telegram.write({ from: chat.user, text: 'about that note', replyTo: own });

			yield* chat.telegram.awaitSent(2);

			assert.deepStrictEqual(chat.telegram.sent[1].text, unknownContext);
			assert.deepStrictEqual(chat.telegram.sent[1].replyToMessageId, reply);
			assert.lengthOf(chat.claude.runs, 1);
		}).pipe(Effect.scoped),
	);

	it.effect('stops a turn when the user presses stop, keeping what Claude wrote, while another turn goes on beside it', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: run.prompt === 'write an essay' ? ['Once upon', ' a time'] : ['Four.'], hang: true }));
			// Messages are answered only after settings.json is read from disk, so the clock moves until the drafts show.
			const advanceUntilDrafts = (n: number) => Effect.raceFirst(chat.telegram.awaitDrafts(n), Effect.forever(TestClock.adjust('1500 millis')));

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'write an essay' });
			yield* advanceUntilDrafts(1);

			const sum = chat.telegram.write({ from: chat.user, text: 'what is 2 + 2?' });

			yield* advanceUntilDrafts(2);
			yield* chat.telegram.stopDraft;
			yield* chat.awaitRecorded(1);

			const [essay, sumRun] = chat.claude.runs;
			const database = new DatabaseSync(chat.journalFile, { readOnly: true });
			const sessions = database.prepare('SELECT session_id FROM chat_sessions').all().map(({ session_id }) => session_id);

			database.close();
			assert.deepStrictEqual([essay.killed, sumRun.killed], [false, true]);
			assert.deepStrictEqual(
				chat.telegram.sent.map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[{ text: 'Four.', replyToMessageId: sum }],
			);
			assert.deepStrictEqual(sessions, [sessionOf(sumRun)]);
		}).pipe(Effect.scoped),
	);

	it.effect('ends the reply with why the turn failed', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat(() => ({ text: ['Let me check'], exitCode: 1, stderr: 'Error: rate limited\nInvalid API key · Please run /login' }));

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'what is on my plate?' });
			yield* chat.telegram.awaitSent(1);

			assert.strictEqual(chat.telegram.sent[0].text, 'Let me check\n\nclaude exited with 1: Invalid API key · Please run /login');
		}).pipe(Effect.scoped, Effect.provide(Logger.layer([]))),
	);

	it.effect('keeps the newest main-chat bot message’s session warm 5 minutes before its 1h prompt cache expires, resuming it into a throwaway fork in its directory', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat();

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'one' });
			yield* chat.awaitRecorded(1);
			chat.telegram.write({ from: chat.user, text: 'two' });
			yield* chat.awaitRecorded(2);
			yield* TestClock.adjust('54 minutes');
			assert.lengthOf(chat.claude.runs, 2);

			yield* TestClock.adjust('1 minute');
			yield* chat.claude.awaitRuns(3);

			const [, latest, keepAlive] = chat.claude.runs;

			assert.deepStrictEqual([keepAlive.prompt, parentOf(keepAlive), keepAlive.cwd], ['ping', sessionOf(latest), homedir()]);
		}).pipe(Effect.scoped),
	);

	it.effect('after a restart, answers what was written while it was down, and nothing twice', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat();
			const first = yield* chat.start;
			const one = chat.telegram.write({ from: chat.user, text: 'one' });

			yield* chat.telegram.awaitSent(1);
			yield* Scope.close(first, Exit.void);

			const two = chat.telegram.write({ from: chat.user, text: 'two' });

			yield* chat.start;

			const three = chat.telegram.write({ from: chat.user, text: 'three' });

			yield* chat.telegram.awaitSent(3);

			assert.deepStrictEqual(chat.telegram.sent.map(({ replyToMessageId }) => replyToMessageId).toSorted(), [one, two, three]);
		}).pipe(Effect.scoped),
	);

	it.effect('passes no message in an epic thread to Claude', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat();

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'how is it going?', topicId: 4242 });
			chat.telegram.write({ from: chat.user, text: 'hello' });
			yield* chat.telegram.awaitSent(1);

			assert.deepStrictEqual(
				chat.claude.runs.map(({ prompt }) => prompt),
				['hello'],
			);
			assert.isUndefined(chat.telegram.sent.find(({ topicId }) => topicId === 4242));
		}).pipe(Effect.scoped),
	);
});

// A project whose topic the bot opened, recorded before the chat starts, as the project topics rule leaves it. The user
// greets the bot first, as Telegram lets the bot write only to a user who wrote to it; the bot client that opens the
// topic receives the greeting, so the chat never answers it.
const withProject = (chat: Effect.Success<ReturnType<typeof makeChat>>) =>
	Effect.gen(function* () {
		chat.telegram.write({ from: chat.user, text: 'hi' });

		const thread = yield* Chat.use((service) => service.openProject('Hivemind')).pipe(Effect.provide(chat.services));
		const repo = join(chat.dir, 'hivemind');
		const project = { team: 'Hivemind', repo, labelReposDirectory: null, thread };

		yield* Projects.use((service) => service.put(project)).pipe(Effect.provide(chat.services));

		const [topic] = chat.telegram.topics();

		return { project, topicId: topic.topicId };
	});

const inTopic = (chat: Effect.Success<ReturnType<typeof makeChat>>, topicId: number) => chat.telegram.sent.filter((message) => message.topicId === topicId);

describe('project topics', () => {
	it.effect("answers a message in a project's topic in its repo with the project in the prompt, and continues a reply from the replied message's session where it ran", () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: [`answer to ${run.prompt}`] }));
			const { project, topicId } = yield* withProject(chat);
			const first = yield* chat.start;


			const question = chat.telegram.write({ from: chat.user, text: 'what is in this repo?', topicId });

			yield* chat.awaitRecorded(1);
			yield* Scope.close(first, Exit.void);

			const [answer] = inTopic(chat, topicId);
			const moved = join(chat.dir, 'hivemind-moved');

			yield* Projects.use((service) => service.put({ ...project, repo: moved })).pipe(Effect.provide(chat.services));
			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'and its tests?', topicId, replyTo: answer.messageId });
			yield* chat.awaitRecorded(2);
			chat.telegram.write({ from: chat.user, text: 'start over', topicId });
			yield* chat.awaitRecorded(3);

			const [asked, followUp, fresh] = chat.claude.runs;
			const prompts = yield* Prompts.pipe(Effect.provide(Prompts.layer));

			assert.deepStrictEqual(
				{ text: answer.text, replyTo: answer.replyToMessageId, cwd: asked.cwd, parent: parentOf(asked), prompt: flagValue(asked.args, '--append-system-prompt') },
				{ text: 'answer to what is in this repo?', replyTo: question, cwd: project.repo, parent: null, prompt: prompts.projectChat(project) },
			);
			assert.deepStrictEqual([followUp.cwd, parentOf(followUp)], [project.repo, sessionOf(asked)]);
			assert.deepStrictEqual([fresh.cwd, parentOf(fresh)], [moved, null]);
			assert.deepStrictEqual(
				inTopic(chat, topicId).map(({ text }) => text),
				['answer to what is in this repo?', 'answer to and its tests?', 'answer to start over'],
			);
		}).pipe(Effect.scoped),
	);

	it.effect("answers a voice note in a project's topic with its transcript, then as if it was typed", () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: [`answer to ${run.prompt}`] }));
			const { project, topicId } = yield* withProject(chat);

			yield* chat.start;

			const voice = chat.telegram.write({ from: chat.user, voice: new TextEncoder().encode('Run the tests.'), topicId });

			yield* chat.awaitRecorded(1);

			const [spoken] = chat.claude.runs;

			assert.deepStrictEqual(
				inTopic(chat, topicId).map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[
					{ text: '🎙 Run the tests.', replyToMessageId: voice },
					{ text: 'answer to Run the tests.', replyToMessageId: voice },
				],
			);
			assert.deepStrictEqual([spoken.prompt, spoken.cwd], ['Run the tests.', project.repo]);
		}).pipe(Effect.scoped),
	);

	it.effect("reminds once, 5 minutes before the prompt cache of a project topic's session expires, with no keep-alive, and a reply to the reminder continues the session", () =>
		Effect.gen(function* () {
			const chat = yield* makeChat((run) => ({ text: [`answer to ${run.prompt}`] }));
			const { project, topicId } = yield* withProject(chat);

			yield* chat.start;
			chat.telegram.write({ from: chat.user, text: 'plan the release', topicId });
			yield* chat.awaitRecorded(1);
			yield* TestClock.adjust('54 minutes');

			assert.lengthOf(inTopic(chat, topicId), 1);

			yield* TestClock.adjust('1 minute');
			yield* chat.awaitRecorded(2);
			yield* TestClock.adjust('3 hours');

			const [answer, reminder] = inTopic(chat, topicId);

			assert.deepStrictEqual(
				inTopic(chat, topicId).map(({ text, replyToMessageId }) => ({ text, replyToMessageId })),
				[
					{ text: 'answer to plan the release', replyToMessageId: answer.replyToMessageId },
					{ text: cacheReminder, replyToMessageId: answer.messageId },
				],
			);
			assert.isTrue(chat.claude.runs.every((run) => run.prompt !== 'ping' || run.cwd !== project.repo));

			chat.telegram.write({ from: chat.user, text: 'go on', topicId, replyTo: reminder.messageId });
			yield* chat.awaitRecorded(3);

			const asked = chat.claude.runs.find((run) => run.prompt === 'plan the release');
			const continued = chat.claude.runs.find((run) => run.prompt === 'go on');

			assert.deepStrictEqual([continued?.cwd, continued === undefined ? null : parentOf(continued)], [project.repo, asked === undefined ? null : sessionOf(asked)]);
		}).pipe(Effect.scoped),
	);

	it.effect('brings a waiting reminder back after a restart, and posts it once', () =>
		Effect.gen(function* () {
			const chat = yield* makeChat();
			const { topicId } = yield* withProject(chat);
			const first = yield* chat.start;

			chat.telegram.write({ from: chat.user, text: 'plan the release', topicId });
			yield* chat.awaitRecorded(1);
			yield* TestClock.adjust('10 minutes');
			yield* Scope.close(first, Exit.void);

			const second = yield* chat.start;

			yield* TestClock.adjust('44 minutes');
			assert.lengthOf(inTopic(chat, topicId), 1);

			yield* TestClock.adjust('1 minute');
			yield* chat.awaitRecorded(2);
			yield* Scope.close(second, Exit.void);
			yield* chat.start;
			yield* TestClock.adjust('1 hour');

			assert.deepStrictEqual(
				inTopic(chat, topicId).map(({ text }) => text),
				['Sure.', cacheReminder],
			);
		}).pipe(Effect.scoped),
	);
});

describe('checkChatSettings', () => {
	// The recorded system/init event runs with outputStyle ADHD and model claude-opus-5-5[1m].
	const check = (settings: Record<string, unknown>) =>
		Effect.gen(function* () {
			const chat = yield* makeChat(() => ({ text: ['pong'], hang: true }));

			// Telegram lets the bot write only to a user who wrote to it.
			chat.telegram.write({ from: chat.user, text: 'hi' });
			mkdirSync(chat.claudeConfigDirectory, { recursive: true });
			writeFileSync(join(chat.claudeConfigDirectory, 'settings.json'), JSON.stringify({ theme: 'dark', ...settings }));
			writeFileSync(join(chat.dir, 'claude.json'), JSON.stringify({ mcpServers: { linear: { type: 'http' } } }));
			yield* checkChatSettings.pipe(Effect.provide(chat.services), Effect.provide(NodeFileSystem.layer));

			return chat;
		});

	it.effect('posts one notice in the main chat naming each key settings.json sets but a chat turn does not run with, before Claude answers', () =>
		Effect.gen(function* () {
			const chat = yield* check({ outputStyle: 'Explanatory', model: 'sonnet' });
			const [run] = chat.claude.runs;

			assert.deepStrictEqual(
				chat.telegram.sent.map(({ chatId, topicId, text }) => ({ chatId, topicId, text })),
				[
					{
						chatId: chat.user,
						topicId: null,
						text: "⚠️ Chat Claude doesn't run with your settings\n- model: claude-opus-5-5[1m], settings say sonnet\n- outputStyle: ADHD, settings say Explanatory\nNext: fix settings.json, or what overrides it for claude -p.",
					},
				],
			);
			assert.isTrue(run.killed);
		}).pipe(Effect.scoped),
	);

	it.effect('posts nothing when a chat turn runs with every checked setting', () =>
		Effect.gen(function* () {
			const chat = yield* check({ outputStyle: 'ADHD', model: 'opus[1m]', permissions: { defaultMode: 'bypassPermissions' } });

			assert.deepStrictEqual(chat.telegram.sent, []);
		}).pipe(Effect.scoped),
	);
});

