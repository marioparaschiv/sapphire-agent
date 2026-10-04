import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { AppConfig } from './config.ts';
import { serveFixture } from './fixture-server.ts';
import { GitHubApp } from './github-app.ts';

// A stand-in for the GitHub App endpoints of api.github.com. Like GitHub, it accepts a request only with an App JWT
// signed by the key whose public half it holds (that of the configured App key), and it times what it mints by the
// JWT's clock, so tokens follow TestClock.

export type AppJwtClaims = { readonly iat: number; readonly exp: number; readonly iss: number };

export type FixtureToken = { readonly installationId: number; readonly token: string; readonly expiresAt: string };

export type GitHubAppFixtureShape = {
	// The API base URL on 127.0.0.1.
	readonly url: string;
	readonly slug: string;
	// Installs the App on the repo (`owner/name`) and returns the installation's id.
	readonly install: (repo: string) => number;
	// The claims of every JWT that verified, in order.
	readonly jwts: () => ReadonlyArray<AppJwtClaims>;
	// Every installation token minted, in order.
	readonly tokens: () => ReadonlyArray<FixtureToken>;
};

const slug = 'orchestratorbot';

// GitHub's installation tokens last an hour.
const tokenLifetimeSeconds = 3600;

const JwtHeader = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal('RS256'), typ: Schema.Literal('JWT') }));

const JwtClaims = Schema.fromJsonString(Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.Int }));

const fromBase64url = (part: string) => Buffer.from(part, 'base64url').toString('utf8');

const make = Effect.gen(function* () {
	const { bot, appPrivateKey } = yield* AppConfig;
	const publicKey = createPublicKey(appPrivateKey);
	const installations = new Map<string, number>();
	const jwts: Array<AppJwtClaims> = [];
	const tokens: Array<FixtureToken> = [];

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

	const answer = (request: IncomingMessage): { readonly status: number; readonly body: unknown } => {
		const claims = verifiedClaims(request.headers.authorization);

		if (Option.isNone(claims)) {
			return { status: 401, body: { message: 'A JSON web token could not be decoded' } };
		}

		jwts.push(claims.value);

		const path = request.url ?? '';
		const installationOf = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
		const accessTokensOf = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);

		if (request.method === 'GET' && path === '/app') {
			return { status: 200, body: { id: bot.app.id, slug, name: 'Orchestrator Bot' } };
		}

		if (request.method === 'GET' && installationOf) {
			const id = installations.get(installationOf[1]);

			return id === undefined ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: { id, app_id: bot.app.id, app_slug: slug } };
		}

		if (request.method === 'POST' && accessTokensOf && [...installations.values()].includes(Number(accessTokensOf[1]))) {
			const installationId = Number(accessTokensOf[1]);
			// GitHub's clock is the one the JWT was signed with: `iat` is backdated 60 s.
			const expiresAt = new Date((claims.value.iat + 60 + tokenLifetimeSeconds) * 1000).toISOString().replace('.000Z', 'Z');
			const minted = { installationId, token: `ghs_${installationId}_${tokens.length + 1}`, expiresAt };

			tokens.push(minted);

			return { status: 201, body: { token: minted.token, expires_at: expiresAt, permissions: { issues: 'write', pull_requests: 'write' }, repository_selection: 'selected' } };
		}

		return { status: 404, body: { message: 'Not Found' } };
	};

	const handle = (request: IncomingMessage, response: ServerResponse) => {
		const { status, body } = answer(request);

		request.resume();
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	};

	const url = yield* serveFixture(handle);

	return {
		url,
		slug,
		install: (repo) => {
			const id = 1000 + installations.size + 1;

			installations.set(repo, id);

			return id;
		},
		jwts: () => [...jwts],
		tokens: () => [...tokens],
	} satisfies GitHubAppFixtureShape;
});

export class GitHubAppFixture extends Context.Service<GitHubAppFixture, GitHubAppFixtureShape>()('herdr-linear/GitHubAppFixture') {
	// A fresh fixture server for the layer's lifetime, plus the real GitHubApp layer pointed at it over a real
	// HttpClient. Both use the configured App id and key.
	static readonly layer = Layer.unwrap(
		Effect.map(make, (fixture) => GitHubApp.layer(fixture.url).pipe(Layer.provide(FetchHttpClient.layer), Layer.merge(Layer.succeed(GitHubAppFixture, fixture)))),
	);
}
