import { createHmac, createPublicKey, randomUUID, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Clock, Context, Effect, Layer, Option, Redacted, Schema, Stream, SubscriptionRef } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { AppConfig } from './config.ts';
import { serveFixture } from './fixture-server.ts';
import { GitHubApp } from './github-app.ts';

// A stand-in for the GitHub App endpoints of api.github.com. Like GitHub, it accepts a request only with an App JWT
// signed by the key whose public half it holds (that of the configured App key), and it times what it mints by the
// JWT's clock, so tokens follow TestClock. It also sends webhook deliveries, as GitHub does, and keeps the App's
// delivery log.

// A GitHub App webhook delivery: the X-GitHub-Event header and the JSON payload.
export type WebhookDelivery = { readonly event: string; readonly payload: unknown };

export const signDelivery = (secret: Redacted.Redacted<string>, body: string) => `sha256=${createHmac('sha256', Redacted.value(secret)).update(body).digest('hex')}`;

const sendDelivery = async (url: string, secret: Redacted.Redacted<string>, { event, payload }: WebhookDelivery, guid: string, signature?: string | null) => {
	const body = JSON.stringify(payload);
	const header = signature === undefined ? signDelivery(secret, body) : signature;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-github-event': event,
			'x-github-delivery': guid,
			...(header === null ? {} : { 'x-hub-signature-256': header }),
		},
		body,
	});

	await response.arrayBuffer();

	return response.status;
};

// POSTs the delivery as GitHub does, signed with `secret` unless `signature` overrides the header (null leaves it out),
// and returns the HTTP status.
export const postDelivery = (url: string, secret: Redacted.Redacted<string>, delivery: WebhookDelivery, signature?: string | null) =>
	Effect.promise(() => sendDelivery(url, secret, delivery, randomUUID(), signature));

// An entry of the App's delivery log, as `GET /app/hook/deliveries` lists it, with what was sent.
export type FixtureDelivery = {
	readonly id: number;
	readonly guid: string;
	readonly deliveredAt: string;
	readonly redelivery: boolean;
	readonly statusCode: number;
	readonly delivery: WebhookDelivery;
};

export type AppJwtClaims = { readonly iat: number; readonly exp: number; readonly iss: number };

export type FixtureToken = { readonly installationId: number; readonly token: string; readonly expiresAt: string };

export type GitHubAppFixtureShape = {
	// The API base URL on 127.0.0.1.
	readonly url: string;
	// Installs the App on the repo (`owner/name`) and returns the installation's id.
	readonly install: (repo: string) => number;
	// The claims of every JWT that verified, in order.
	readonly jwts: () => ReadonlyArray<AppJwtClaims>;
	// Every installation token minted, in order.
	readonly tokens: () => ReadonlyArray<FixtureToken>;
	// Where deliveries are sent; until set, or once that server is gone, a delivery fails with 502, as nginx answers
	// when the listener is down.
	readonly setWebhookUrl: (url: string) => void;
	// Sends the delivery to the webhook URL as a new event and logs the attempt.
	readonly deliver: (delivery: WebhookDelivery) => Effect.Effect<FixtureDelivery>;
	// Logs an attempt with the given status without sending it, as a new event unless `guid` names an earlier one's.
	readonly addDelivery: (delivery: WebhookDelivery, statusCode: number, guid?: string) => Effect.Effect<FixtureDelivery>;
	// Answers `POST /app/hook/deliveries/{id}/attempts` for the delivery with 422 and sends nothing, `times` times.
	readonly refuseRedelivery: (id: number, times: number) => void;
	// The delivery log, newest first.
	readonly deliveries: () => ReadonlyArray<FixtureDelivery>;
	// Answers the next `times` `GET /app/hook/deliveries` with 403, as GitHub does without the permission.
	readonly refuseDeliveryPages: (times: number) => void;
	// The ids of the deliveries GitHub was asked to redeliver and did, in order.
	readonly redelivered: () => ReadonlyArray<number>;
	// The `cursor` of each `GET /app/hook/deliveries`, null for the first page, in order.
	readonly deliveryPages: () => ReadonlyArray<string | null>;
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

const Action = Schema.Struct({ action: Schema.String });

type Answer = { readonly status: number; readonly body: unknown; readonly link?: string };

const make = Effect.gen(function* () {
	const { bot, appPrivateKey, webhookSecret } = yield* AppConfig;
	const publicKey = createPublicKey(appPrivateKey);
	const installations = new Map<string, number>();
	const jwts: Array<AppJwtClaims> = [];
	const tokens: Array<FixtureToken> = [];
	const log: Array<FixtureDelivery> = [];
	const refusals = new Map<number, number>();
	let pageRefusals = 0;
	const answers = yield* SubscriptionRef.make(0);
	const redelivered: Array<number> = [];
	const deliveryPages: Array<string | null> = [];
	let webhookUrl: string | undefined;
	let lastDeliveryId = 90_000_000_000;

	const record = (delivery: WebhookDelivery, guid: string, nowMillis: number, statusCode: number) => {
		lastDeliveryId += 1;

		const entry = { id: lastDeliveryId, guid, deliveredAt: isoSeconds(nowMillis), redelivery: log.some((earlier) => earlier.guid === guid), statusCode, delivery };

		log.unshift(entry);

		return entry;
	};

	const send = async (delivery: WebhookDelivery, guid: string, nowMillis: number) => {
		const statusCode = webhookUrl === undefined ? 502 : await sendDelivery(webhookUrl, webhookSecret, delivery, guid).catch(() => 502);

		return record(delivery, guid, nowMillis, statusCode);
	};

	const listed = ({ id, guid, deliveredAt, redelivery, statusCode, delivery }: FixtureDelivery) => ({
		id,
		guid,
		delivered_at: deliveredAt,
		redelivery,
		duration: 0.27,
		status: statusCode >= 200 && statusCode < 300 ? 'OK' : `Invalid HTTP Response: ${statusCode}`,
		status_code: statusCode,
		event: delivery.event,
		action: Option.getOrNull(Option.map(Schema.decodeUnknownOption(Action)(delivery.payload), ({ action }) => action)),
		installation_id: 1001,
		repository_id: 1_000_001,
	});

	const deliveriesPage = (url: URL): Answer => {
		const perPage = Number(url.searchParams.get('per_page') ?? 30);
		const cursor = url.searchParams.get('cursor');
		const after = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor.replace(/^v1_/, ''));
		const older = log.filter(({ id }) => id < after);
		const page = older.slice(0, perPage);

		deliveryPages.push(cursor);

		if (pageRefusals > 0) {
			pageRefusals -= 1;

			return { status: 403, body: { message: 'Resource not accessible by integration' } };
		}

		return {
			status: 200,
			body: page.map(listed),
			...(older.length > perPage ? { link: `<${url.origin}/app/hook/deliveries?per_page=${perPage}&cursor=v1_${page[page.length - 1].id}>; rel="next"` } : {}),
		};
	};

	const redeliver = async (id: number, nowMillis: number): Promise<Answer> => {
		const original = log.find((entry) => entry.id === id);

		if (original === undefined) {
			return { status: 404, body: { message: 'Not Found' } };
		}

		const refusalsLeft = refusals.get(id) ?? 0;

		if (refusalsLeft > 0) {
			refusals.set(id, refusalsLeft - 1);

			return { status: 422, body: { message: 'Validation Failed' } };
		}

		redelivered.push(id);
		await send(original.delivery, original.guid, nowMillis);

		return { status: 202, body: {} };
	};

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

	const answer = async (request: IncomingMessage): Promise<Answer> => {
		const claims = verifiedClaims(request.headers.authorization);

		if (Option.isNone(claims)) {
			return { status: 401, body: { message: 'A JSON web token could not be decoded' } };
		}

		jwts.push(claims.value);

		const url = new URL(request.url ?? '', `http://${request.headers.host}`);
		const path = url.pathname;
		const installationOf = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
		const accessTokensOf = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
		const attemptsOf = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path);
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

		if (request.method === 'GET' && path === '/app/hook/deliveries') {
			return deliveriesPage(url);
		}

		if (request.method === 'POST' && attemptsOf) {
			return redeliver(Number(attemptsOf[1]), nowMillis);
		}

		return { status: 404, body: { message: 'Not Found' } };
	};

	const handle = (request: IncomingMessage, response: ServerResponse) => {
		request.resume();
		void answer(request).then(({ status, body, link }) => {
			response.writeHead(status, { 'content-type': 'application/json', ...(link === undefined ? {} : { link }) });
			response.end(JSON.stringify(body));
		});
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
		setWebhookUrl: (url) => {
			webhookUrl = url;
		},
		deliver: (delivery) => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.promise(() => send(delivery, randomUUID(), now))),
		addDelivery: (delivery, statusCode, guid = randomUUID()) => Effect.map(Clock.currentTimeMillis, (now) => record(delivery, guid, now, statusCode)),
		refuseRedelivery: (id, times) => {
			refusals.set(id, times);
		},
		refuseDeliveryPages: (times) => {
			pageRefusals = times;
		},
		deliveries: () => [...log],
		redelivered: () => [...redelivered],
		deliveryPages: () => [...deliveryPages],
		awaitAnswers: (n) => SubscriptionRef.changes(answers).pipe(Stream.takeUntil((count) => count >= n), Stream.runDrain),
	} satisfies GitHubAppFixtureShape;
	const client = Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, HttpClient.transformResponse(Effect.onExit(() => SubscriptionRef.update(answers, (count) => count + 1)))),
	).pipe(Layer.provide(FetchHttpClient.layer));

	return { fixture, client };
});

export class GitHubAppFixture extends Context.Service<GitHubAppFixture, GitHubAppFixtureShape>()('herdr-linear/GitHubAppFixture') {
	// A fresh fixture server for the layer's lifetime, plus the real GitHubApp layer pointed at it over a real
	// HttpClient. Both use the configured App id and key.
	static readonly layer = Layer.unwrap(
		Effect.map(make, ({ fixture, client }) => GitHubApp.layer(fixture.url).pipe(Layer.provide(client), Layer.merge(Layer.succeed(GitHubAppFixture, fixture)))),
	);
}
