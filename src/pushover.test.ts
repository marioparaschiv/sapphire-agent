import type { IncomingMessage, ServerResponse } from 'node:http';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Permanent } from './call-policy.ts';
import { PushoverConfig } from './config.ts';
import { serveFixture } from './fixture-server.ts';
import { Pushover } from './pushover.ts';

const appToken = 'azGDORePK8gMaC0QOYAMyEEuzJnyUi';
const userKey = 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG';

// A stand-in for api.pushover.net that keeps the form of every message and answers as Pushover does: 200, or 400 with
// its errors for an unknown user.
const pushoverServer = Effect.gen(function* () {
	const received: Array<Record<string, string>> = [];

	const handle = (request: IncomingMessage, response: ServerResponse) => {
		let body = '';

		request.setEncoding('utf8').on('data', (chunk: string) => {
			body += chunk;
		});
		request.on('end', () => {
			const form = Object.fromEntries(new URLSearchParams(body));
			const known = form.user === userKey;

			received.push(form);
			response.writeHead(known ? 200 : 400, { 'content-type': 'application/json' });
			response.end(JSON.stringify(known ? { status: 1, request: 'r-1' } : { user: 'invalid', errors: ['user identifier is not a valid user, group, or subscribed user key'], status: 0, request: 'r-2' }));
		});
	};

	const url = yield* serveFixture(handle);

	return { url, received };
});

const pushoverWith = (url: string, user: string) =>
	Pushover.layer(url).pipe(
		Layer.provide(Layer.succeed(PushoverConfig, { appToken: Redacted.make(appToken), userKey: Redacted.make(user) })),
		Layer.provide(FetchHttpClient.layer),
	);

describe('Pushover live layer', () => {
	it.effect('posts the title, message, priority and link as a form with the app token and user key', () =>
		Effect.gen(function* () {
			const server = yield* pushoverServer;

			yield* Pushover.use((pushover) =>
				Effect.all([
					pushover.send({ title: 'sapphire-agent cannot observe', message: 'Linear could not be reached', priority: 'high' }),
					pushover.send({ title: 'HL-60 is ready for review', message: 'The PR is open.', url: 'https://github.com/test/repo/pull/1', priority: 'normal' }),
				]),
			).pipe(Effect.provide(pushoverWith(server.url, userKey)));

			assert.deepStrictEqual(server.received, [
				{ token: appToken, user: userKey, title: 'sapphire-agent cannot observe', message: 'Linear could not be reached', priority: '1' },
				{ token: appToken, user: userKey, title: 'HL-60 is ready for review', message: 'The PR is open.', priority: '0', url: 'https://github.com/test/repo/pull/1' },
			]);
		}),
	);

	it.effect("fails Permanent with Pushover's errors when it refuses the message", () =>
		Effect.gen(function* () {
			const server = yield* pushoverServer;
			const error = yield* Pushover.use((pushover) => pushover.send({ title: 'Test', message: 'Test', priority: 'normal' })).pipe(
				Effect.provide(pushoverWith(server.url, 'uQiRzpo4DXghDmr9QzzfQu27cmVRsX')),
				Effect.flip,
			);

			assert.deepStrictEqual(error, new Permanent({ message: 'Pushover answered HTTP 400: user identifier is not a valid user, group, or subscribed user key' }));
		}),
	);
});
