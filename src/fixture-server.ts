import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { Effect } from 'effect';

export const readBody = async (request: IncomingMessage) => {
	const chunks: Array<Buffer> = [];

	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString('utf8');
};

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
