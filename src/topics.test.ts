import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { notRunning } from './conversations.ts';
import { type Harness, makeHarness } from './test-harness.ts';

// The harness's project Test has a topic of its own.
const epicTopics = (h: Harness) => h.telegram.topics().filter(({ title }) => title !== '📁 Test');

const titles = (h: Harness) => epicTopics(h).map(({ title }) => title);

const sentTexts = (h: Harness) => h.telegram.sent.map(({ text }) => text);

// The user has written to the bot, so it may write to them.
const greet = (h: Harness) => h.telegram.write({ from: h.telegramUser, text: 'hi' });

// What the bot wrote in the epic's topic.
const inTopic = (h: Harness) => {
	const [topic] = epicTopics(h);

	return h.telegram.sent.filter(({ topicId }) => topicId === topic.topicId).map(({ text }) => text);
};

// A PostToolUse hook payload as Claude Code writes it once a skill ran; `agent_id` when a subagent ran it.
const skillHook = (sessionId: string, skill: string, agentId?: string) =>
	JSON.stringify({
		session_id: sessionId,
		transcript_path: `/home/dev/.claude/projects/-tmp/${sessionId}.jsonl`,
		cwd: '/tmp',
		hook_event_name: 'PostToolUse',
		tool_name: 'Skill',
		tool_input: { skill },
		tool_response: { success: true, commandName: skill },
		...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'general-purpose' }),
	});

describe('topics', () => {
	it.effect('gives a dispatched epic exactly one topic, also across restarts', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			greet(h);
			h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);
			assert.strictEqual(h.telegram.topicsCreated(), 2);
			assert.deepStrictEqual(
				epicTopics(h).map(({ chatId }) => chatId),
				[h.telegramUser],
			);
		}),
	);

	it.effect('never gives a topic to an epic that is not running', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			greet(h);
			h.linear.addEpic({ identifier: 'TEST-10', title: 'Waiting in Ready' });
			h.linear.addEpic({ identifier: 'TEST-11', title: 'Waiting for review', state: 'To Review' });
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Shipped long ago', state: 'Shipped' });
			yield* h.pausedTick;

			assert.deepStrictEqual(titles(h), []);

			const exited = yield* makeHarness();
			const { run } = yield* exited.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });

			exited.herdr.setAgent(run.paneId, null);
			yield* exited.tick;
			greet(exited);
			yield* exited.tick;

			assert.deepStrictEqual(titles(exited), []);
		}),
	);

	it.effect("names the topic by the run's state as it moves between working, awaiting input and error", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working', tail: '⏺ Reading src/sync' });

			greet(h);
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);

			h.herdr.setAgentStatus(run.paneId, 'idle');
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['⏸ TEST-10 Plugin settings sync']);

			h.herdr.setAgentStatus(run.paneId, 'working');
			h.herdr.setTail(run.paneId, '⏺ Writing src/sync/merge.ts');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);

			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['🔴 TEST-10 Plugin settings sync']);
			assert.strictEqual(h.telegram.topicsCreated(), 2);
		}),
	);

	it.effect('posts an opened PR once in the topic, once in the main chat and once on the Linear epic', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });

			greet(h);
			yield* h.tick;

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const [topic] = epicTopics(h);

			assert.deepStrictEqual(
				h.telegram.sent.map(({ text, topicId }) => ({ text, topicId })),
				[
					{ text: `PR opened: ${pullRequest.url}`, topicId: topic.topicId },
					{ text: `TEST-10 Plugin settings sync: PR opened ${pullRequest.url}`, topicId: null },
				],
			);
			assert.deepStrictEqual(
				h.linear.comments(epic.id).map(({ body }) => body.split('\n\n')[0]),
				[`PR opened: ${pullRequest.url}`],
			);
		}),
	);

	it.effect('sums up a shipped epic in the Done topic and deletes its topic, and a stopped one is only deleted', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 2 });
			const shipped = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working', subIssues: 3 });

			yield* h.startedRun({ identifier: 'TEST-11', title: 'Dark mode', agentStatus: 'working' });
			greet(h);
			yield* h.tick;

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: shipped.run.branch, author: 'marioparaschiv' });

			yield* h.tick;
			yield* h.ctl('stop', 'TEST-11');
			h.moveEpic(shipped.epic.id, 'Shipped');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['✅ Done']);
			assert.deepStrictEqual(sentTexts(h).slice(2), [`TEST-10 Plugin settings sync · ${pullRequest.url} · 3 slices`]);
			assert.strictEqual(h.telegram.sent[2].topicId, epicTopics(h)[0].topicId);
		}),
	);

	it.effect('keeps the topic of an epic whose run ended while it waits for review, and deletes it when the epic is moved back', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run, epic } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });

			greet(h);
			yield* h.tick;
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });
			h.writeResultFile(run, JSON.stringify({ summary: 'Settings sync.', replies: [], flags: [] }));
			yield* h.tick;
			assert.deepStrictEqual(titles(h), ['👀 TEST-10 Plugin settings sync']);

			h.moveEpic(epic.id, 'To Do');
			yield* h.tick;
			assert.deepStrictEqual(titles(h), []);
		}),
	);

	it.effect('posts a slice once when it starts and once when it is done, across polls and restarts', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working', subIssues: 2 });
			const [first, second] = h.linear.subIssues(epic.id);

			greet(h);
			yield* h.tick;
			h.moveEpic(first.id, 'Implementing');
			yield* h.tick;
			yield* h.tick;
			yield* h.restart;
			h.moveEpic(first.id, 'Done');
			yield* h.tick;
			yield* h.tick;
			h.moveEpic(second.id, 'Implementing');
			yield* h.restart;
			yield* h.tick;

			const writes = h.telegram.writes();

			yield* h.tick;
			assert.strictEqual(h.telegram.writes(), writes);
			assert.deepStrictEqual(inTopic(h), ['▶️ TEST-101 Slice 1 started', '✔️ TEST-101 Slice 1 done', '▶️ TEST-102 Slice 2 started']);
		}),
	);

	it.effect("posts a phase once when the run's agent starts /sreview, /review-verify or /pr, and nothing for other skills or a subagent's", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const other = yield* h.startedRun({ identifier: 'TEST-11', title: 'Dark mode', agentStatus: 'working' });

			greet(h);
			yield* h.tick;

			for (const payload of [
				skillHook(run.session.id, 'sreview'),
				skillHook(run.session.id, 'tdd'),
				skillHook(run.session.id, 'sreview', 'a1b2c3'),
				skillHook(run.session.id, 'review-verify'),
				skillHook(run.session.id, 'sapphire-tools:pr'),
			]) {
				assert.deepStrictEqual(yield* h.hook('claude', payload, run.paneId), { code: 0, stdout: '', stderr: '' });
			}

			assert.deepStrictEqual(yield* h.hook('claude', skillHook(other.run.session.id, 'tdd'), other.run.paneId), { code: 0, stdout: '', stderr: '' });
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const topic = epicTopics(h).find(({ title }) => title.includes('TEST-10'));

			assert.isDefined(topic);
			assert.deepStrictEqual(
				h.telegram.sent.map(({ text, topicId }) => [text, topicId]),
				['🔎 /sreview started', '🔎 /review-verify started', '🔎 /pr started'].map((text) => [text, topic.topicId]),
			);
		}),
	);

	it.effect("types a message written in an epic's topic into its run's agent, which goes on", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ awaitingInputAfterSeconds: 180 }, { answerChat: true });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle', tail: '❯ Which should win, local or remote?' });

			greet(h);
			yield* h.tick;
			yield* TestClock.adjust('3 minutes');
			yield* h.tick;

			const [topic] = epicTopics(h);
			const before = h.journalWrites();

			h.telegram.write({ from: h.telegramUser, text: 'Remote wins.\nKeep a backup of local.', topicId: topic.topicId });
			yield* h.awaitJournalWrites(before + 1);
			yield* h.tick;
			h.herdr.setAgentStatus(run.paneId, 'working');
			h.herdr.setTail(run.paneId, '⏺ Writing src/sync/merge.ts');
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Remote wins. Keep a backup of local.' }]);
			assert.deepStrictEqual((yield* h.runs).map(({ status }) => status), ['running']);
			assert.deepStrictEqual(titles(h), ['🟢 TEST-10 Plugin settings sync']);
		}),
	);

	it.effect("types a voice note in an epic's topic into its run's agent as its transcript", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({}, { answerChat: true });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			greet(h);
			yield* h.tick;

			const before = h.journalWrites();
			const voice = h.telegram.write({ from: h.telegramUser, voice: new TextEncoder().encode('Use the remote copy.'), topicId: epicTopics(h)[0].topicId });

			yield* h.awaitJournalWrites(before + 1);
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.prompts(), [{ paneId: run.paneId, text: 'Use the remote copy.' }]);
			assert.deepStrictEqual(
				h.telegram.sent.filter(({ replyToMessageId }) => replyToMessageId === voice).map(({ text }) => text),
				['🎙 Use the remote copy.'],
			);
		}),
	);

	it.effect('answers a message in the topic of an epic that is not running with one line, and passes it on nowhere', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({}, { answerChat: true });
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });

			greet(h);
			yield* h.tick;
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });
			h.writeResultFile(run, JSON.stringify({ summary: 'Settings sync.', replies: [], flags: [] }));
			yield* h.tick;

			const [topic] = epicTopics(h);
			const sent = h.telegram.sent.length;
			const message = h.telegram.write({ from: h.telegramUser, text: 'Also add a test.', topicId: topic.topicId });

			yield* h.telegram.awaitSent(sent + 1);
			yield* h.tick;

			const answer = h.telegram.sent.at(-1);

			assert.deepStrictEqual([answer?.text, answer?.replyToMessageId, answer?.topicId], [notRunning('TEST-10'), message, topic.topicId]);
			assert.deepStrictEqual(h.herdr.prompts(), []);
			assert.deepStrictEqual((yield* h.ctl('status')).filter((line) => line.startsWith('request ')), []);
		}),
	);
});
