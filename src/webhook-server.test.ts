import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect, FileSystem, Layer, Queue, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { AppConfig } from './config.ts';
import { asClaude } from './github.ts';
import { GitHubAppFixture, postDelivery, signDelivery } from './github-app-fixture.ts';
import type { Command } from './journal.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Reconciler } from './reconciler.ts';
import { deliveries, type Harness, makeHarness, plannerDependencies } from './test-harness.ts';
import { WebhookServer } from './webhook-server.ts';

const reviewedPullRequest = (h: Harness) => h.github.addPullRequest({ repo: h.githubRepo, branch: 'mario/test-10-plugin-settings-sync', author: 'marioparaschiv' });

const described = (commands: ReadonlyArray<Command>) => commands.map(({ author, body, status }) => [author, body, status]);

describe('WebhookServer', () => {
	it.effect('starts exactly one command run for a mention by an allowed user in an issue comment, a review comment or a review body', () =>
		Effect.gen(function* () {
			const mentionedIn = [
				(h: Harness, number: number) => deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@OrchestratorBot stop TEST-12', 'MarioParaschiv')),
				(h: Harness, number: number) => {
					h.github.addThread(h.githubRepo, number, { comments: [{ body: 'Rename this. @orchestratorbot' }] });

					return deliveries.reviewComment(h.githubRepo, number, h.github.thread('PRRT_1').comments[0]);
				},
				(h: Harness, number: number) => deliveries.review(h.githubRepo, number, { id: 'PRR_kwDO7', body: 'A few things. @orchestratorbot have a follow-up fix them', author: 'marioparaschiv' }),
			];

			for (const delivery of mentionedIn) {
				const h = yield* makeHarness();
				const { number } = reviewedPullRequest(h);
				const sent = delivery(h, number);

				assert.strictEqual(yield* h.deliver(sent), 204, sent.event);
				yield* h.tick;
				yield* h.tick;

				const [command, ...others] = yield* h.commands;

				assert.deepStrictEqual([command.status, command.repo, command.number, others], ['running', h.githubRepo, number, []], sent.event);
				assert.lengthOf(h.herdr.starts(), 1, sent.event);
			}

			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);

			yield* h.deliver(mentionedIn[2](h, number));
			assert.deepStrictEqual(
				(yield* h.commands).map(({ commentId, url }) => [commentId, url]),
				[['PRR_kwDO7', `https://github.com/${h.githubRepo}/pull/${number}#pullrequestreview-7`]],
			);
		}),
	);

	it.effect("records a mention by anyone else as ignored, and skips the App's and the agent's own comments and those that do not mention the bot", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);
			const comment = (body: string, author?: string) => deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, body, author));
			const statuses = yield* Effect.forEach(
				[
					comment('@orchestratorbot merge this', 'stranger'),
					comment('Mention @orchestratorbot again to retry.', 'orchestratorbot[bot]'),
					comment(asClaude('Ready for review. Mention @orchestratorbot to ask for changes.')),
					comment('Thanks, orchestratorbot.'),
					deliveries.review(h.githubRepo, number, { id: 'PRR_kwDO9', body: null, author: 'marioparaschiv' }),
				],
				(delivery) => h.deliver(delivery),
			);

			yield* h.tick;

			assert.deepStrictEqual(statuses, [204, 204, 204, 204, 204]);
			assert.deepStrictEqual(described(yield* h.commands), [['stranger', '@orchestratorbot merge this', 'ignored']]);
			assert.deepStrictEqual(h.herdr.starts(), []);
		}),
	);

	it.effect('starts one run for a delivery that arrives twice, before or after the run started', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);
			const sent = deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot what is running?'));

			assert.deepStrictEqual([yield* h.deliver(sent), yield* h.deliver(sent)], [204, 204]);
			yield* h.tick;
			assert.strictEqual(yield* h.deliver(sent), 204);
			yield* h.tick;

			assert.deepStrictEqual(described(yield* h.commands), [['marioparaschiv', '@orchestratorbot what is running?', 'running']]);
			assert.lengthOf(h.herdr.starts(), 1);
		}),
	);

	it.effect('refuses a missing or wrong signature with 401, a malformed payload with 400, and answers other events and actions with 204', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);
			const comment = h.github.addComment(h.githubRepo, number, '@orchestratorbot pause');
			const sent = deliveries.issueComment(h.githubRepo, number, comment);
			const otherBody = JSON.stringify(deliveries.issueComment(h.githubRepo, number, comment, 'deleted').payload);

			assert.deepStrictEqual(
				[
					yield* h.deliver(sent, null),
					yield* h.deliver(sent, signDelivery(Redacted.make('not-the-secret'), JSON.stringify(sent.payload))),
					yield* h.deliver(sent, signDelivery(Redacted.make('test-webhook-secret'), otherBody)),
					yield* h.deliver(sent, 'sha1=0123456789abcdef'),
				],
				[401, 401, 401, 401],
			);
			assert.deepStrictEqual(
				[
					yield* h.deliver({ event: 'ping', payload: { zen: 'Keep it logically awesome.', hook_id: 1 } }),
					yield* h.deliver({ event: 'issues', payload: { action: 'opened', issue: { number: 9 } } }),
					yield* h.deliver(deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot stop'), 'edited')),
					yield* h.deliver(deliveries.review(h.githubRepo, number, { id: 'PRR_kwDO3', body: '@orchestratorbot never mind', author: 'marioparaschiv' }, 'dismissed')),
					yield* h.deliver({ event: 'issue_comment', payload: { action: 'created', issue: { number } } }),
				],
				[204, 204, 204, 204, 400],
			);
			assert.deepStrictEqual(yield* h.commands, []);
		}),
	);

	it.effect('answers 500 when the command cannot be recorded, so a redelivery starts the run', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = reviewedPullRequest(h);
			const sent = deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot status'));

			h.crashAtJournalWrite(1);
			assert.strictEqual(yield* h.deliver(sent), 500);
			assert.isTrue(h.crashed());
			assert.deepStrictEqual(yield* h.commands, []);

			yield* h.restart;
			assert.strictEqual(yield* h.deliver(sent), 204);
			yield* h.tick;

			assert.deepStrictEqual(described(yield* h.commands), [['marioparaschiv', '@orchestratorbot status', 'running']]);
			assert.lengthOf(h.herdr.starts(), 1);
		}),
	);

	it.effect('wakes the reconciler for a queued command, before the next poll', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
			const ticks = yield* Queue.unbounded<number>();
			const probe = { name: 'probe', pausable: false, plan: () => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Queue.offer(ticks, now)), Effect.as([])) };
			const context = yield* Layer.build(
				WebhookServer.layer.pipe(
					Layer.provideMerge(Reconciler.layer.pipe(Layer.provide(Planner.layer(Effect.succeed([probe]))), Layer.provide(Pause.layer))),
					Layer.provideMerge(GitHubAppFixture.layer),
					Layer.provideMerge(plannerDependencies(directory, { pollSeconds: 30 })),
				),
			);
			const reconciler = yield* Reconciler.pipe(Effect.provide(context));
			const { url } = yield* WebhookServer.pipe(Effect.provide(context));
			const { webhookSecret } = yield* AppConfig.pipe(Effect.provide(context));
			const comment = { id: 'IC_kwDO5', url: 'https://github.com/test/repo/pull/1#issuecomment-5', body: '@orchestratorbot status', author: 'marioparaschiv' };

			yield* Effect.forkScoped(reconciler.run);
			assert.strictEqual(yield* Queue.take(ticks), 0);

			yield* TestClock.adjust('10 seconds');
			assert.strictEqual(yield* postDelivery(url, webhookSecret, deliveries.issueComment('test/repo', 1, comment)), 204);
			assert.strictEqual(yield* Queue.take(ticks), 10_000);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
