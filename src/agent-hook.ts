import { createConnection } from 'node:net';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

// In the state directory.
export const eventSocketName = 'events.sock';

// What `sapphire hook <agent>` sends: the agent's own hook payload, untouched, and the herdr pane it runs in. The service
// decodes the payload with that agent's adapter and answers one line, `ok` or the reason it refused the event.
export type EventEnvelope = { readonly agent: string; readonly paneId: string | null; readonly payload: string };

const send = (path: string, envelope: EventEnvelope) =>
	new Promise<string>((resolve, reject) => {
		const socket = createConnection(path, () => socket.write(`${JSON.stringify(envelope)}\n`));
		let answer = '';

		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			answer += chunk;
		});
		socket.on('end', () => resolve(answer.trim()));
		socket.on('error', reject);
	});

const isServiceDown = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');

// Run by an agent's hook on every session event. Only node built-ins, so it starts in milliseconds.
const main = async (agent: string | undefined) => {
	const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR;

	if (agent === undefined || stateDirectory === undefined) {
		console.error('usage: HERDR_PLUGIN_STATE_DIR=<dir> sapphire hook <agent>');
		process.exitCode = 2;

		return;
	}

	const envelope = { agent, paneId: process.env.HERDR_PANE_ID ?? null, payload: await text(process.stdin) };

	try {
		const answer = await send(join(stateDirectory, eventSocketName), envelope);

		if (answer !== 'ok') {
			console.error(`sapphire-agent refused the ${agent} event: ${answer}`);
			process.exitCode = 1;
		}
	} catch (error) {
		// The service is not running. Events only make it act sooner; its next poll sees the same state.
		if (isServiceDown(error)) {
			return;
		}

		throw error;
	}
};

if (import.meta.main) {
	await main(process.argv[2]);
}
