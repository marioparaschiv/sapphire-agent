import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Transient } from './call-policy.ts';
import { deliveries, type Harness, makeHarness } from './test-harness.ts';

const greet = (h: Harness) => h.telegram.write({ from: h.telegramUser, text: 'hi' });

const topicOf = (h: Harness, title: string) => {
	const topic = h.telegram.topics().find((candidate) => candidate.title === title);

	if (!topic) {
		throw new Error(`no topic ${title}`);
	}

	return topic.topicId;
};

// Where each sent message landed: the title of its topic, or main.
const placed = (h: Harness) =>
	h.telegram.sent.map(({ text, topicId }) => [text.split('\n')[0], topicId === null ? 'main' : (h.telegram.topics().find((topic) => topic.topicId === topicId)?.title ?? 'deleted')]);

describe('notices', () => {
	it.effect("sends a notice to the epic's topic while it is open, else to its project's topic, else to the main chat", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', tail: '$ claude\nSegmentation fault' });

			greet(h);
			yield* h.tick;

			// TEST-10 has a topic; TEST-21 has none, so its project's topic gets it; CMD-1 runs in a repo of no project.
			h.herdr.setAgent(run.paneId, null);
			h.linear.addEpic({ identifier: 'TEST-21', title: 'Still busy', state: 'Shipped' });
			h.herdr.addTab({ label: 'TEST-21 Still busy', agentStatus: 'working' });
			h.herdr.setStartBehaviour('no-agent');

			const { number } = h.github.addPullRequest({ repo: 'acme/elsewhere', branch: 'mario/test-30-docs', author: 'marioparaschiv' });

			yield* h.deliver(deliveries.issueComment('acme/elsewhere', number, h.github.addComment('acme/elsewhere', number, '@orchestratorbot what is running?')));
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(placed(h), [
				['👻 An untracked agent works on TEST-21: no run of the epic tracks it.', '📁 Test'],
				['🔴 TEST-10 stopped: the agent exited without writing its result file.', '🔴 TEST-10 Plugin settings sync'],
				[placed(h)[2][0], 'main'],
			]);
			assert.match(placed(h)[2][0], /^🔴 CMD-1 could not start: /);
			assert.isTrue([...h.notices('TEST-10'), ...h.notices('TEST-21'), ...h.notices('CMD-1')].every(({ sent }) => sent));
		}),
	);

	it.effect('sends a notice whose topic the user deleted to the main chat', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			greet(h);
			yield* h.tick;
			h.telegram.deleteTopic(topicOf(h, '🟢 TEST-10 Plugin settings sync'));
			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;

			assert.deepStrictEqual(placed(h), [["🔴 TEST-10 stopped: the agent exited without writing its result file.", 'main']]);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [true]);
		}),
	);

	it.effect('sends a notice exactly once after a restart, when the process died before sending it or before marking it sent', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			// The user never wrote to the bot, so Telegram refuses every send, as when it is down; then the process dies.
			h.herdr.setAgent(run.paneId, null);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				h.notices('TEST-10').map(({ marker, sent }) => [marker, sent]),
				[['error:0', false]],
			);
			assert.deepStrictEqual(placed(h), []);

			yield* h.restart;
			greet(h);
			// The project's topic is made, then the notice goes through and the process dies before marking it sent.
			h.telegram.crashAfterWrite(2, new Transient({ message: 'the process died' }));
			yield* h.tick;
			assert.deepStrictEqual(placed(h), [['🔴 TEST-10 stopped: the agent exited without writing its result file.', '📁 Test']]);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [false]);

			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(placed(h), [['🔴 TEST-10 stopped: the agent exited without writing its result file.', '📁 Test']]);
			assert.deepStrictEqual(
				h.notices('TEST-10').map(({ marker, sent }) => [marker, sent]),
				[['error:0', true]],
			);
		}),
	);
});
