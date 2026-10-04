import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { AppConfig } from './config.ts';
import { serveFixture } from './fixture-server.ts';
import { GitHubAppFixture, type WebhookDelivery } from './github-app-fixture.ts';
import { Journal } from './journal.ts';
import { MissedDeliveries } from './missed-deliveries.ts';
import { deliveries, makeHarness } from './test-harness.ts';

const layer = MissedDeliveries.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Journal.layer(':memory:'), GitHubAppFixture.layer)),
	Layer.provideMerge(AppConfig.layerTest('/tmp/herdr-linear-test')),
);

const ping: WebhookDelivery = { event: 'ping', payload: { zen: 'Design for failure.', hook_id: 1 } };

// A webhook listener that accepts every delivery; yields the X-GitHub-Delivery of each it got.
const listener = Effect.gen(function* () {
	const received = yield* Queue.unbounded<string>();
	const url = yield* serveFixture((request, response) => {
		request.resume();
		Queue.offerUnsafe(received, String(request.headers['x-github-delivery']));
		response.writeHead(204);
		response.end();
	});

	return { url, received };
});

const scan = MissedDeliveries.use(({ scan }) => scan);

const newest = GitHubAppFixture.useSync(({ deliveries }) => deliveries()[0]);

describe('MissedDeliveries', () => {
	it.effect('redelivers exactly the events whose newest attempt failed, once each, oldest first', () =>
		Effect.gen(function* () {
			const app = yield* GitHubAppFixture;

			yield* app.addDelivery(ping, 200);
			const down = yield* app.addDelivery(ping, 502);
			const errored = yield* app.addDelivery(ping, 500);
			yield* app.addDelivery(ping, 204, errored.guid);
			const stillDown = yield* app.addDelivery(ping, 502);
			const stillDownAgain = yield* app.addDelivery(ping, 504, stillDown.guid);
			yield* app.addDelivery(ping, 202);

			yield* scan;

			assert.deepStrictEqual(app.redelivered(), [down.id, stillDownAgain.id]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('redelivers an event on every scan while its redeliveries fail, and stops once one succeeds', () =>
		Effect.gen(function* () {
			const app = yield* GitHubAppFixture;
			const down = yield* app.addDelivery(ping, 502);

			yield* scan;
			const failedAgain = yield* newest;
			yield* scan;
			const failedOnceMore = yield* newest;

			const { url, received } = yield* listener;

			app.setWebhookUrl(url);
			yield* scan;
			const succeeded = yield* newest;
			yield* scan;

			assert.deepStrictEqual(app.redelivered(), [down.id, failedAgain.id, failedOnceMore.id]);
			assert.deepStrictEqual([failedAgain.statusCode, failedOnceMore.statusCode, succeeded.statusCode, succeeded.guid], [502, 502, 204, down.guid]);
			assert.deepStrictEqual(yield* Queue.clear(received), [down.guid]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('pages back at most 3 days on the first scan, then only back to the newest delivery it saw', () =>
		Effect.gen(function* () {
			const app = yield* GitHubAppFixture;
			const { url } = yield* listener;
			const start = Date.UTC(2026, 9, 1, 12);

			app.setWebhookUrl(url);
			yield* TestClock.setTime(start);
			yield* Effect.repeat(app.addDelivery(ping, 200).pipe(Effect.andThen(TestClock.adjust('1 minute'))), { times: 88 });
			const expired = yield* app.addDelivery(ping, 502);

			yield* TestClock.adjust('1 day');
			const recent = yield* Effect.forEach(Array.from({ length: 210 }, (_, index) => index), (index) =>
				app.addDelivery(ping, [0, 105, 209].includes(index) ? 502 : 200).pipe(Effect.tap(() => TestClock.adjust('1 minute'))),
			);
			const listed = app.deliveries();

			yield* TestClock.setTime(start + 89 * 60_000 + 3 * 86_400_000 + 1);
			yield* scan;

			assert.deepStrictEqual(app.deliveryPages(), [null, `v1_${listed[99].id}`, `v1_${listed[199].id}`]);
			assert.deepStrictEqual(app.redelivered(), [recent[0].id, recent[105].id, recent[209].id]);
			assert.isFalse(app.redelivered().includes(expired.id));

			yield* app.addDelivery(ping, 200);
			const later = yield* app.addDelivery(ping, 502);
			yield* scan;

			assert.deepStrictEqual(app.deliveryPages().slice(3), [null]);
			assert.deepStrictEqual(app.redelivered().slice(3), [later.id]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('keeps the mark where it was while GitHub refuses a redelivery, so the next scan tries it again', () =>
		Effect.gen(function* () {
			const app = yield* GitHubAppFixture;
			const journal = yield* Journal;
			const { url } = yield* listener;

			app.setWebhookUrl(url);
			const refused = yield* app.addDelivery(ping, 502);
			const other = yield* app.addDelivery(ping, 500);

			app.refuseRedelivery(refused.id, 1);
			yield* scan;

			assert.deepStrictEqual(app.redelivered(), [other.id]);
			assert.deepStrictEqual(yield* journal.deliveryMark, Option.none());

			yield* scan;
			const mark = yield* journal.deliveryMark;

			assert.deepStrictEqual(app.redelivered(), [other.id, refused.id]);
			assert.isTrue(Option.isSome(mark) && mark.value > other.id);

			yield* scan;
			assert.deepStrictEqual(app.redelivered(), [other.id, refused.id]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('scans at once and then every deliveryScanSeconds, going on after a failed scan', () =>
		Effect.gen(function* () {
			const app = yield* GitHubAppFixture;
			const { url, received } = yield* listener;
			// GitHub's clock when it was asked to redeliver: that of the newest App JWT.
			const lastCallAt = () => new Date((app.jwts()[app.jwts().length - 1].iat + 60) * 1000).toISOString();

			app.setWebhookUrl(url);
			yield* TestClock.setTime(Date.UTC(2026, 9, 4, 12));
			const first = yield* app.addDelivery(ping, 502);

			yield* Effect.forkScoped(MissedDeliveries.use(({ run }) => run));
			assert.strictEqual(yield* Queue.take(received), first.guid);
			assert.strictEqual(lastCallAt(), '2026-10-04T12:00:00.000Z');

			// GET /app, the first page, the redelivery.
			yield* app.awaitAnswers(3);
			app.refuseDeliveryPages(1);
			yield* TestClock.adjust('5 minutes');
			yield* app.awaitAnswers(4);
			const second = yield* app.addDelivery(ping, 502);
			yield* TestClock.adjust('5 minutes');

			assert.strictEqual(yield* Queue.take(received), second.guid);
			assert.strictEqual(lastCallAt(), '2026-10-04T12:10:00.000Z');
			assert.deepStrictEqual(app.deliveryPages(), [null, null, null]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('starts exactly one command run for a mention delivered while the webhook listener was down', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch: 'mario/test-10-plugin-settings-sync', author: 'marioparaschiv' });
			const mention = deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot status'));

			yield* h.stop;
			const missed = yield* h.app.deliver(mention);

			yield* h.restart;
			yield* h.scanDeliveries;
			yield* h.tick;
			yield* h.scanDeliveries;
			yield* h.tick;

			assert.strictEqual(missed.statusCode, 502);
			assert.deepStrictEqual(h.app.redelivered(), [missed.id]);
			assert.deepStrictEqual(
				(yield* h.commands).map(({ body, status }) => [body, status]),
				[['@orchestratorbot status', 'running']],
			);
			assert.lengthOf(h.herdr.starts(), 1);
		}),
	);

	it.effect('runs a missed mention once when the scan crashes after its redelivery, before moving its mark', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch: 'mario/test-10-plugin-settings-sync', author: 'marioparaschiv' });
			const mention = deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot status'));

			yield* h.stop;
			const missed = yield* h.app.deliver(mention);

			yield* h.restart;
			// Write 1 records the redelivered command; write 2 is the mark.
			h.crashAtJournalWrite(2);
			assert.isTrue(Exit.hasDies(yield* Effect.exit(h.scanDeliveries)));
			assert.isTrue(h.crashed());

			yield* h.restart;
			yield* h.scanDeliveries;
			yield* h.tick;

			assert.deepStrictEqual(h.app.redelivered(), [missed.id]);
			assert.deepStrictEqual(
				(yield* h.commands).map(({ body, status }) => [body, status]),
				[['@orchestratorbot status', 'running']],
			);
			assert.lengthOf(h.herdr.starts(), 1);
		}),
	);
});
