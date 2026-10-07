import { createConnection } from 'node:net';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { defaultStateDirectory } from './directories.ts';

// In the state directory.
export const eventSocketName = 'events.sock';

// What `sapphire hook <agent>` sends: the agent's own hook payload, untouched. The service decodes the payload with that
// agent's adapter and answers `ok` or the reason it refused the event on the first line; after `ok`, the rest is what
// the hook prints for the agent.
export type EventEnvelope = { readonly agent: string; readonly payload: string };

// Within Claude's 10 s hook timeout, so a service that hangs never holds the hook until Claude kills it.
const answerTimeoutMs = 5_000;

const send = (path: string, envelope: EventEnvelope) =>
	new Promise<string>((resolve, reject) => {
		const socket = createConnection(path, () => socket.write(`${JSON.stringify(envelope)}\n`));
		let answer = '';

		socket.setTimeout(answerTimeoutMs, () => socket.destroy(new Error(`sapphire-agent did not answer within ${answerTimeoutMs} ms`)));

		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			answer += chunk;
		});
		socket.on('end', () => resolve(answer.trim()));
		socket.on('error', reject);
	});

const isServiceDown = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');

// What the service answers for the event to print for the agent. A refusal fails the hook with the reason, unless the
// hook's answer comes from elsewhere: Claude ignores the output of a hook that failed.
const forward = async (stateDirectory: string, envelope: EventEnvelope, failOnRefusal: boolean) => {
	try {
		const answer = await send(join(stateDirectory, eventSocketName), envelope);
		const [status, ...output] = answer.split('\n');

		if (status !== 'ok') {
			console.error(`sapphire-agent refused the ${envelope.agent} event: ${answer}`);

			if (failOnRefusal) {
				process.exitCode = 1;
			}

			return [];
		}

		return output;
	} catch (error) {
		// The service is not running. Events only make it act sooner; its next poll sees the same state, and the next tool
		// call checks the context again.
		if (isServiceDown(error)) {
			return [];
		}

		throw error;
	}
};

// The Claude events the hook answers itself for a dispatched run (`run-hooks.ts`), so its guards hold while the
// service is down. A PreToolUse goes to the service too, as a sign the agent works, but only the guard answers it.
const eventName = (payload: string) => {
	const parsed: unknown = JSON.parse(payload);

	return typeof parsed === 'object' && parsed !== null && 'hook_event_name' in parsed ? String(parsed.hook_event_name) : undefined;
};

// Run by an agent's hook on every session event. Only node built-ins, so it starts in milliseconds; the run hooks load
// the rest only for their events.
const main = async (agent: string | undefined) => {
	const stateDirectory = process.env.SAPPHIRE_AGENT_STATE_DIR ?? defaultStateDirectory;

	if (agent === undefined) {
		console.error('usage: sapphire hook <agent>');
		process.exitCode = 2;

		return;
	}

	const payload = await text(process.stdin);
	const event = eventName(payload);
	const runHook = agent === 'claude' && event === 'PreToolUse' ? import('./run-hooks.ts').then(({ answerRunHook }) => answerRunHook(payload)) : undefined;

	const forwarded = forward(stateDirectory, { agent, payload }, event !== 'PreToolUse');
	// A PreToolUse goes to the service only as a sign of activity, so failing to send it never costs the guard's answer.
	const [output, answer] = await Promise.all([
		event === 'PreToolUse'
			? forwarded.catch((error: unknown) => {
					console.error(`cannot send the ${agent} event to sapphire-agent: ${String(error)}`);

					return [];
				})
			: forwarded,
		runHook,
	]);

	if (event === 'PreToolUse') {
		if (answer !== undefined) {
			process.stdout.write(`${answer}\n`);
		}

		return;
	}

	if (output.length > 0) {
		process.stdout.write(`${output.join('\n')}\n`);
	}
};

if (import.meta.main) {
	await main(process.argv[2]);
}
