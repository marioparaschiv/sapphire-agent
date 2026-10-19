import { NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { sendEvent } from './agent-hook.ts';
import { T3Config } from './config.ts';
import { defaultStateDirectory } from './directories.ts';
import { type PiHook, type PiThread, piToolCall } from './pi-hooks.ts';
import { decideToolCall } from './run-hooks.ts';
import { T3 } from './t3.ts';

// The Pi extension that does for a Pi session what `sapphire hook claude` does for Claude: it sends the session's
// events to the service and prints what it answers into the tool's result, and it guards tool calls itself, so the
// guards hold while the service is down. Pi loads it from `extensions` in its settings (`operations.md`, Install).

// The parts of Pi's extension API (`@earendil-works/pi-coding-agent`) this uses, which Pi passes at runtime.
type PiContext = {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui: { readonly notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
	readonly sessionManager: { readonly getSessionId: () => string };
	readonly getContextUsage: () => { readonly tokens: number | null } | undefined;
};

type TextContent = { readonly type: 'text'; readonly text: string };

type PiEvents = {
	readonly session_start: { readonly event: { readonly reason: Extract<PiHook, { readonly event: 'session_start' }>['reason'] }; readonly result: void };
	readonly before_agent_start: { readonly event: object; readonly result: void };
	readonly tool_call: {
		readonly event: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>> };
		readonly result: { readonly block: true; readonly reason: string } | undefined;
	};
	// `parentToolCallId` is set on a call another tool (e.g. codemode) made, whose result only that tool sees.
	readonly tool_result: {
		readonly event: { readonly toolName: string; readonly parentToolCallId?: string; readonly content: ReadonlyArray<unknown> };
		readonly result: { readonly content: ReadonlyArray<unknown> } | undefined;
	};
	readonly agent_end: { readonly event: object; readonly result: void };
	readonly agent_settled: { readonly event: object; readonly result: void };
	readonly session_shutdown: { readonly event: object; readonly result: void };
};

type PiApi = {
	readonly on: <Name extends keyof PiEvents>(name: Name, handler: (event: PiEvents[Name]['event'], ctx: PiContext) => Promise<PiEvents[Name]['result']>) => void;
};

// What an event's payload adds to what every payload has.
type Fields<Hook = PiHook> = Hook extends PiHook ? Omit<Hook, 'sessionId' | 'cwd' | 'thread'> : never;

// Longer than that, the event goes without its thread, so the service drops it, and the next event asks again.
const threadLookupTimeout = '5 seconds';

// T3 runs Pi with its thread's MCP endpoint and token in env; outside T3 there are none, and no thread.
const currentThread = Effect.gen(function* () {
	const t3 = yield* T3;
	const threadId = yield* t3.currentThread;
	const { thread } = yield* t3.readThread({ threadId, limit: 1 });

	return { threadId, parentThreadId: thread.parentThreadId, relationshipToParent: thread.relationshipToParent } satisfies PiThread;
}).pipe(
	Effect.timeout(threadLookupTimeout),
	Effect.provide(T3.layer.pipe(Layer.provide(T3Config.layerForAgent), Layer.provide(FetchHttpClient.layer), Layer.provide(NodeServices.layer))),
);

export default function sapphire(pi: PiApi) {
	const stateDirectory = process.env.SAPPHIRE_AGENT_STATE_DIR ?? defaultStateDirectory;
	let thread: Promise<PiThread | null> | undefined;

	// Asked once a session started and kept, as the session stays in its thread; a failed lookup is asked again.
	const threadOf = () => {
		thread ??= Effect.runPromise(currentThread).catch(() => {
			thread = undefined;

			return null;
		});

		return thread;
	};

	const report = async (ctx: PiContext, fields: Fields) => {
		const payload: PiHook = { ...fields, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, thread: await threadOf() };
		const answer = await sendEvent(stateDirectory, { agent: 'pi', payload: JSON.stringify(payload) });

		if ('refusal' in answer) {
			throw new Error(`sapphire-agent refused the pi event: ${answer.refusal}`);
		}

		return answer.output;
	};

	const warn = (ctx: PiContext, what: string) => (error: unknown) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`sapphire-agent: ${what}: ${String(error)}`, 'warning');
		}
	};

	// As Claude's async hooks: the session goes on without waiting for the service.
	const notify = (ctx: PiContext, fields: Fields) => {
		report(ctx, fields).catch(warn(ctx, `cannot send the ${fields.event} event`));
	};

	const contextTokens = (ctx: PiContext) => ctx.getContextUsage()?.tokens ?? null;

	pi.on('session_start', async ({ reason }, ctx) => notify(ctx, { event: 'session_start', reason }));

	pi.on('before_agent_start', async (_event, ctx) => notify(ctx, { event: 'before_agent_start' }));

	// Guarded whether or not the service runs. A guard that fails lets the call run, as Claude does when its hook fails.
	pi.on('tool_call', async ({ toolName, input }, ctx) => {
		notify(ctx, { event: 'tool_call', toolName });

		const decision = await decideToolCall(ctx.cwd, piToolCall(toolName, input)).catch((error: unknown) => {
			warn(ctx, `cannot guard the ${toolName} call`)(error);

			return undefined;
		});

		return decision?.allow === false ? { block: true, reason: decision.reason } : undefined;
	});

	// What the service answers, a subagent's handoff instruction, goes at the end of the result the agent reads next.
	pi.on('tool_result', async ({ toolName, parentToolCallId, content }, ctx) => {
		if (parentToolCallId !== undefined) {
			return undefined;
		}

		const output = await report(ctx, { event: 'tool_result', toolName, contextTokens: contextTokens(ctx) }).catch((error: unknown) => {
			warn(ctx, 'cannot send the tool_result event')(error);

			return [];
		});
		const text: TextContent = { type: 'text', text: output.join('\n') };

		return output.length === 0 ? undefined : { content: [...content, text] };
	});

	pi.on('agent_end', async (_event, ctx) => notify(ctx, { event: 'agent_end', contextTokens: contextTokens(ctx) }));

	pi.on('agent_settled', async (_event, ctx) => notify(ctx, { event: 'agent_settled' }));

	// Waited for, as Pi may exit right after.
	pi.on('session_shutdown', async (_event, ctx) => {
		await report(ctx, { event: 'session_shutdown' }).catch(warn(ctx, 'cannot send the session_shutdown event'));
	});
}
