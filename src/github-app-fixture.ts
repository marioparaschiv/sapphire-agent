import { createPublicKey, randomUUID, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context, Effect, Layer, Option, Redacted, Schema, Stream, SubscriptionRef } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { AppConfig } from './config.ts';
import { hmacHex, postJson, serveFixture } from './fixture-server.ts';
import { GitHubApp } from './github-app.ts';

// A stand-in for the GitHub App endpoints of api.github.com. Like GitHub, it accepts a request only with an App JWT
// signed by the key whose public half it holds (that of the configured App key), and it times what it mints by the
// JWT's clock, so tokens follow TestClock.

// A GitHub App webhook delivery: the X-GitHub-Event header and the JSON payload.
export type WebhookDelivery = { readonly event: string; readonly payload: unknown };

export const signDelivery = (secret: Redacted.Redacted<string>, body: string) => `sha256=${hmacHex(secret, body)}`;

// POSTs the delivery as GitHub does, signed with `secret` unless `signature` overrides the header (null leaves it out),
// and returns the HTTP status.
export const postDelivery = (url: string, secret: Redacted.Redacted<string>, { event, payload }: WebhookDelivery, signature?: string | null) =>
	Effect.promise(() => {
		const body = JSON.stringify(payload);
		const header = signature === undefined ? signDelivery(secret, body) : signature;

		return postJson(url, body, { 'x-github-event': event, 'x-github-delivery': randomUUID(), ...(header === null ? {} : { 'x-hub-signature-256': header }) });
	});

export type AppJwtClaims = { readonly iat: number; readonly exp: number; readonly iss: number };

export type FixtureToken = { readonly installationId: number; readonly token: string; readonly expiresAt: string };

type GitHubAppFixtureShape = {
	// The API base URL on 127.0.0.1.
	readonly url: string;
	// Installs the App on the repo (`owner/name`) and returns the installation's id.
	readonly install: (repo: string) => number;
	// The claims of every JWT that verified, in order.
	readonly jwts: () => ReadonlyArray<AppJwtClaims>;
	// Every installation token minted, in order.
	readonly tokens: () => ReadonlyArray<FixtureToken>;
	// Completes once the fixture's GitHubApp layer has got n answers (a response or a transport error) in total, so
	// TestClock.adjust cannot time out a call in flight.
	readonly awaitAnswers: (n: number) => Effect.Effect<void>;
};

const slug = 'orchestratorbot';

// GitHub's installation tokens last an hour.
const tokenLifetimeSeconds = 3600;

const JwtHeader = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal('RS256'), typ: Schema.Literal('JWT') }));

const JwtClaims = Schema.fromJsonString(Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.Int }));

const fromBase64url = (part: string) => Buffer.from(part, 'base64url').toString('utf8');

const isoSeconds = (millis: number) => new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z');

type Answer = { readonly status: number; readonly body: unknown };

const make = Effect.gen(function* () {
	const { bot, appPrivateKey } = yield* AppConfig;
	const publicKey = createPublicKey(appPrivateKey);
	const installations = new Map<string, number>();
	const jwts: Array<AppJwtClaims> = [];
	const tokens: Array<FixtureToken> = [];
	const answers = yield* SubscriptionRef.make(0);

	const verifiedClaims = (authorization: string | undefined): Option.Option<AppJwtClaims> => {
		const [header = '', payload = '', signature = ''] = (authorization ?? '').replace(/^Bearer /, '').split('.');

		if (!verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) {
			return Option.none();
		}

		return Option.filter(
			Option.all([Schema.decodeUnknownOption(JwtHeader)(fromBase64url(header)), Schema.decodeUnknownOption(JwtClaims)(fromBase64url(payload))]).pipe(Option.map(([, claims]) => claims)),
			(claims) => claims.iss === bot.app.id,
		);
	};

	const answer = (request: IncomingMessage): Answer => {
		const claims = verifiedClaims(request.headers.authorization);

		if (Option.isNone(claims)) {
			return { status: 401, body: { message: 'A JSON web token could not be decoded' } };
		}

		jwts.push(claims.value);

		const url = new URL(request.url ?? '', `http://${request.headers.host}`);
		const path = url.pathname;
		const installationOf = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
		const accessTokensOf = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
		// GitHub's clock is the one the JWT was signed with: `iat` is backdated 60 s.
		const nowMillis = (claims.value.iat + 60) * 1000;

		if (request.method === 'GET' && path === '/app') {
			return { status: 200, body: { id: bot.app.id, slug, name: 'Orchestrator Bot' } };
		}

		if (request.method === 'GET' && installationOf) {
			const id = installations.get(installationOf[1]);

			return id === undefined ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: { id, app_id: bot.app.id, app_slug: slug } };
		}

		if (request.method === 'POST' && accessTokensOf && [...installations.values()].includes(Number(accessTokensOf[1]))) {
			const installationId = Number(accessTokensOf[1]);
			const expiresAt = isoSeconds(nowMillis + tokenLifetimeSeconds * 1000);
			const minted = { installationId, token: `ghs_${installationId}_${tokens.length + 1}`, expiresAt };

			tokens.push(minted);

			return { status: 201, body: { token: minted.token, expires_at: expiresAt, permissions: { issues: 'write', pull_requests: 'write' }, repository_selection: 'selected' } };
		}

		return { status: 404, body: { message: 'Not Found' } };
	};

	const handle = (request: IncomingMessage, response: ServerResponse) => {
		request.resume();

		const { status, body } = answer(request);

		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	};

	const url = yield* serveFixture(handle);

	const fixture = {
		url,
		install: (repo) => {
			const id = 1000 + installations.size + 1;

			installations.set(repo, id);

			return id;
		},
		jwts: () => [...jwts],
		tokens: () => [...tokens],
		awaitAnswers: (n) => SubscriptionRef.changes(answers).pipe(Stream.takeUntil((count) => count >= n), Stream.runDrain),
	} satisfies GitHubAppFixtureShape;
	const client = Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, HttpClient.transformResponse(Effect.onExit(() => SubscriptionRef.update(answers, (count) => count + 1)))),
	).pipe(Layer.provide(FetchHttpClient.layer));

	return { fixture, client };
});

export class GitHubAppFixture extends Context.Service<GitHubAppFixture, GitHubAppFixtureShape>()('sapphire-agent/GitHubAppFixture') {
	// A fresh fixture server for the layer's lifetime, plus the real GitHubApp layer pointed at it over a real
	// HttpClient. Both use the configured App id and key.
	static readonly layer = Layer.unwrap(
		Effect.map(make, ({ fixture, client }) => GitHubApp.layer(fixture.url).pipe(Layer.provide(client), Layer.merge(Layer.succeed(GitHubAppFixture, fixture)))),
	);
}
