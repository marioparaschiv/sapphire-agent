import { createHmac } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { Effect, Redacted } from 'effect';

// A node:http server on 127.0.0.1 and a free port while the scope is open. Returns its base URL, e.g.
// `http://127.0.0.1:41234`.
export const serveFixture = (listener: RequestListener) =>
	Effect.gen(function* () {
		const server = yield* Effect.acquireRelease(
			Effect.callback<ReturnType<typeof createServer>>((resume) => {
				const created = createServer(listener);

				created.listen(0, '127.0.0.1', () => resume(Effect.succeed(created)));
			}),
			(created) =>
				Effect.callback<void>((resume) => {
					created.closeAllConnections();
					created.close(() => resume(Effect.void));
				}),
		);
		const address = server.address();

		if (address === null || typeof address === 'string') {
			return yield* Effect.die(new Error(`fixture server has no TCP address: ${address}`));
		}

		return `http://127.0.0.1:${address.port}`;
	});

export const hmacHex = (secret: Redacted.Redacted<string>, body: string) => createHmac('sha256', Redacted.value(secret)).update(body).digest('hex');

// POSTs the JSON body with the given headers and returns the HTTP status.
export const postJson = async (url: string, body: string, headers: Record<string, string>) => {
	const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

	await response.arrayBuffer();

	return response.status;
};
