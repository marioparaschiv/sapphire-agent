import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { type Harness, makeHarness } from './test-harness.ts';

const titles = (h: Harness) => h.telegram.topics().map(({ title }) => title);

describe('project topics', () => {
	it.effect("opens a project's topic once, also across restarts, again after the user deletes it, deletes it with the project and opens one when it is added", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			// Telegram lets the bot write only to a user who wrote to it.
			h.telegram.write({ from: h.telegramUser, text: 'hi' });
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['📁 Test']);
			assert.strictEqual(h.telegram.topicsCreated(), 1);

			const [deleted] = h.telegram.topics();

			h.telegram.deleteTopic(deleted.topicId);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['📁 Test']);
			assert.strictEqual(h.telegram.topicsCreated(), 2);
			assert.notStrictEqual(h.telegram.topics()[0].topicId, deleted.topicId);

			yield* h.ctl('project', 'remove', 'Test');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(titles(h), []);
			assert.strictEqual(h.telegram.topicsCreated(), 2);

			yield* h.ctl('project', 'add', 'Test', h.repo);
			yield* h.tick;

			assert.deepStrictEqual(titles(h), ['📁 Test']);
			assert.strictEqual(h.telegram.topicsCreated(), 3);
		}),
	);
});
