import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { GitHubApp } from './github-app.ts';
import { GitHubAppFixture } from './github-app-fixture.ts';

const config = AppConfig.layerTest('/tmp/sapphire-agent-test');

const layer = GitHubAppFixture.layer.pipe(Layer.provideMerge(config));

describe('GitHubApp', () => {
	it.effect("reads the App's login from GitHub, with a JWT backdated 60 s that expires within 10 min and verifies against the key's public half", () =>
		Effect.gen(function* () {
			const now = Date.UTC(2026, 9, 4, 12) / 1000;

			yield* TestClock.setTime(now * 1000);

			const mentionHandle = AppConfig.layerTest('/tmp/sapphire-agent-test', {
				bot: {
					login: 'mention-handle',
					app: { id: 424242, privateKeyFile: '/tmp/sapphire-agent-test/app.pem', webhookSecretFile: '/tmp/sapphire-agent-test/webhook-secret', webhookPort: 0 },
					allowedUsers: ['marioparaschiv'],
				},
			});
			const [login, jwts] = yield* Effect.all([GitHubApp.useSync(({ login }) => login), GitHubAppFixture.useSync(({ jwts }) => jwts())]).pipe(
				Effect.provide(GitHubAppFixture.layer.pipe(Layer.provideMerge(mentionHandle))),
			);

			assert.strictEqual(login, 'orchestratorbot[bot]');
			assert.deepStrictEqual(jwts, [{ iat: now - 60, exp: now + 540, iss: 424242 }]);
		}),
	);

	it.effect('fails to start, Permanent, when GitHub rejects the JWT of a key that is not the App\'s', () =>
		Effect.gen(function* () {
			const fixture = yield* GitHubAppFixture;
			const otherKey = GitHubApp.layer(fixture.url).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppConfig.layerTest('/tmp/sapphire-agent-test')));
			const exit = yield* Layer.build(otherKey).pipe(Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(new Permanent({ message: 'GitHub answered HTTP 401 to GET /app: A JSON web token could not be decoded' })));
		}).pipe(Effect.provide(layer)),
	);

	it.effect('reuses each installation its own token until 5 min before it expires, then mints a new one', () =>
		Effect.gen(function* () {
			const app = yield* GitHubApp;
			const fixture = yield* GitHubAppFixture;
			const web = fixture.install('acme/web');
			const api = fixture.install('acme/api');
			const tokenFor = (repo: string) => app.installationToken(repo).pipe(Effect.map(Redacted.value));

			const first = yield* tokenFor('acme/web');
			const again = yield* tokenFor('acme/web');
			const other = yield* tokenFor('acme/api');

			yield* TestClock.adjust('54 minutes');
			const beforeMargin = yield* tokenFor('acme/web');

			yield* TestClock.adjust('1 minute');
			const refreshed = yield* tokenFor('acme/web');
			const otherRefreshed = yield* tokenFor('acme/api');

			assert.deepStrictEqual([first, again, other, beforeMargin, refreshed, otherRefreshed], ['ghs_1001_1', 'ghs_1001_1', 'ghs_1002_2', 'ghs_1001_1', 'ghs_1001_3', 'ghs_1002_4']);
			assert.deepStrictEqual(
				fixture.tokens().map(({ installationId, expiresAt }) => [installationId, expiresAt]),
				[
					[web, '1970-01-01T01:00:00Z'],
					[api, '1970-01-01T01:00:00Z'],
					[web, '1970-01-01T01:55:00Z'],
					[api, '1970-01-01T01:55:00Z'],
				],
			);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('fails Permanent for a repo the App is not installed on', () =>
		Effect.gen(function* () {
			const error = yield* GitHubApp.use((app) => app.installationToken('acme/private')).pipe(Effect.flip);

			assert.deepStrictEqual(error, new Permanent({ message: 'GitHub answered HTTP 404 to GET /repos/acme/private/installation: Not Found' }));
		}).pipe(Effect.provide(layer)),
	);
});
