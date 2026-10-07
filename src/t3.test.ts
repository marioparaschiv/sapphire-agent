import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Permanent } from './call-policy.ts';
import { T3Config } from './config.ts';
import { serveFixture } from './fixture-server.ts';
import { T3, T3ToolFailure, T3Unauthorized } from './t3.ts';

// What T3 answered to these calls, recorded from the live server: the `result` of each JSON-RPC reply.
const recorded = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/t3', `${name}.json`), 'utf8'));

const token = 'eyJ2IjoxLCJraW5kIjoic2Vzc2lvbiJ9.c2lnbmF0dXJl';

const RpcRequest = Schema.Struct({
	id: Schema.optionalKey(Schema.Number),
	method: Schema.String,
	params: Schema.optionalKey(
		Schema.Struct({
			name: Schema.optionalKey(Schema.String),
			arguments: Schema.optionalKey(Schema.Struct({ cursor: Schema.optionalKey(Schema.Int), modelSelection: Schema.optionalKey(Schema.Unknown) })),
		}),
	),
});

// A tool result as T3 shapes them, the value both as text and as structured content.
const toolResult = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });

type Seen = { readonly method: string; readonly tool?: string; readonly sessionId?: string; readonly protocolVersion?: string };

// How the server answers tools/call: the recorded result as JSON, the same after a progress notification as
// server-sent events, or a JSON-RPC error.
type ToolAnswer = { readonly result: unknown; readonly asEvents?: boolean } | { readonly error: { readonly code: number; readonly message: string } };

type ToolArguments = { readonly cursor?: number; readonly modelSelection?: unknown };

// A stand-in for T3's /mcp endpoint, which checks the bearer token and the MCP session as T3 does: 401 for another
// token, 404 for a session it does not know, 400 for a request without one.
const serveMcp = (tools: Record<string, ToolAnswer | ((args: ToolArguments) => ToolAnswer)>) =>
	Effect.gen(function* () {
		const seen: Array<Seen> = [];
		const sessions = new Set<string>();
		let sessionsOpened = 0;

		const reply = (response: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}) => {
			response.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
			response.end(body);
		};

		const answer = (request: IncomingMessage, response: ServerResponse, text: string) => {
			const { id, method, params } = Schema.decodeUnknownSync(RpcRequest)(JSON.parse(text));
			const sessionId = request.headers['mcp-session-id'];
			const protocolVersion = request.headers['mcp-protocol-version'];

			seen.push({
				method,
				...(params?.name === undefined ? {} : { tool: params.name }),
				...(typeof sessionId === 'string' ? { sessionId } : {}),
				...(typeof protocolVersion === 'string' ? { protocolVersion } : {}),
			});

			if (request.headers.authorization !== `Bearer ${token}`) {
				return reply(response, 401, JSON.stringify({ error: 'invalid_mcp_credential', message: 'A valid T3 Code MCP credential is required.' }), {
					'www-authenticate': 'Bearer error="invalid_token"',
				});
			}

			if (method === 'initialize') {
				sessionsOpened += 1;

				const created = `session-${sessionsOpened}`;

				sessions.add(created);

				return reply(response, 200, JSON.stringify({ jsonrpc: '2.0', id, result: recorded('initialize') }), { 'mcp-session-id': created, 'mcp-protocol-version': '2025-06-18' });
			}

			if (typeof sessionId !== 'string') {
				return reply(response, 400);
			}

			if (!sessions.has(sessionId)) {
				return reply(response, 404);
			}

			if (method === 'notifications/initialized') {
				return reply(response, 202);
			}

			if (method === 'ping') {
				return reply(response, 200, JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
			}

			const named = tools[params?.name ?? ''];
			const tool = typeof named === 'function' ? named(params?.arguments ?? {}) : named;

			if (tool === undefined) {
				return reply(response, 200, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: `Tool '${params?.name}' not found` } }));
			}

			if ('error' in tool) {
				return reply(response, 200, JSON.stringify({ jsonrpc: '2.0', id, error: tool.error }));
			}

			if (tool.asEvents) {
				const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: id, progress: 1 } });

				response.writeHead(200, { 'content-type': 'text/event-stream' });

				return response.end(`data: ${progress}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: tool.result })}\n\n`);
			}

			return reply(response, 200, JSON.stringify({ jsonrpc: '2.0', id, result: tool.result }));
		};

		const url = yield* serveFixture((request, response) => {
			const chunks: Array<Buffer> = [];

			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => answer(request, response, Buffer.concat(chunks).toString('utf8')));
		});

		return { url, seen: () => [...seen], forgetSessions: () => sessions.clear() };
	});

const recordedSettings = join(import.meta.dirname, 'fixtures/t3/settings.json');

const t3With = (url: string, presented = token, settingsFile = recordedSettings) =>
	T3.layer.pipe(
		Layer.provide(Layer.succeed(T3Config, { url, token: Redacted.make(presented), expiresAt: Date.UTC(2036, 9, 4), settingsFile })),
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(NodeFileSystem.layer),
	);

// t3_thread_launch as T3 answers it in a project without a default model.
const launchTool = ({ modelSelection }: ToolArguments): ToolAnswer =>
	modelSelection === undefined
		? {
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								_tag: 'OrchestratorMcpFailure',
								code: 'invalid_request',
								message: 'Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.',
							}),
						},
					],
					isError: true,
				},
			}
		: {
				result: toolResult({
					threadId: '7c0e1f52-9a3b-4d8e-b6f1-2a4c5d6e7f80',
					projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd',
					modelSelection,
					runId: 'run:thread:7c0e1f52-9a3b-4d8e-b6f1-2a4c5d6e7f80:ordinal:1',
					status: 'preparing',
				}),
			};

const launchInput = {
	projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd',
	title: 'HL-74 Launch with the default model',
	message: 'Implement HL-74 and open a PR.',
	workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'agent/hl-74-default-model', startFromOrigin: true },
	runtimeMode: 'full-access',
} as const;

describe('T3', () => {
	it.effect('opens an MCP session once, then calls tools in it, reading their structured content', () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({
				t3_project_list: { result: recorded('project-list') },
				// The recorded first page says the next starts at 3.
				t3_thread_list: ({ cursor = 0 }) =>
					cursor === 0
						? { result: recorded('thread-list') }
						: { result: toolResult({ projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd', currentThreadId: null, threads: [], nextCursor: null, total: 3 }) },
			});
			const [projects, threads] = yield* Effect.all([T3.use((t3) => t3.listProjects), T3.use((t3) => t3.listThreads({ projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd' }))]).pipe(
				Effect.provide(t3With(server.url)),
			);

			assert.deepStrictEqual(projects, [
				{ id: '599d8e00-4dc0-4c36-aa38-4ebb6c02bad5', title: 'hivemind.ts', workspaceRoot: '/home/dev/hivemind.ts' },
				{ id: '1975f15c-daea-4ef5-92e8-4854c122d672', title: 'telecord', workspaceRoot: '/home/dev/telecord' },
				{ id: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd', title: 'sapphire-agent', workspaceRoot: '/home/dev/sapphire-agent' },
				{ id: 'mcp:62f28e99-2299-4397-a5a1-ddf95b681ee0', title: 'unbound', workspaceRoot: '/home/dev/unbound' },
			]);
			assert.deepStrictEqual(
				threads.map(({ title, status, relationshipToParent }) => [title, status, relationshipToParent]),
				[
					['Orchestrate HL-60 Sapphire Agent Token', 'completed', null],
					['HL-65 T3 port slice', 'idle', 'subagent'],
					['Multi-platform message abstraction with Telegram streaming', 'idle', null],
				],
			);
			assert.deepStrictEqual(server.seen(), [
				{ method: 'initialize' },
				{ method: 'notifications/initialized', sessionId: 'session-1', protocolVersion: '2025-06-18' },
				{ method: 'tools/call', tool: 't3_project_list', sessionId: 'session-1', protocolVersion: '2025-06-18' },
				{ method: 'tools/call', tool: 't3_thread_list', sessionId: 'session-1', protocolVersion: '2025-06-18' },
				{ method: 'tools/call', tool: 't3_thread_list', sessionId: 'session-1', protocolVersion: '2025-06-18' },
			]);
		}),
	);

	it.effect('reads a result from its text content without structured content, and from server-sent events', () =>
		Effect.gen(function* () {
			const { structuredContent: _, ...textOnly } = Schema.decodeUnknownSync(Schema.Struct({ structuredContent: Schema.Unknown, content: Schema.Unknown, isError: Schema.Boolean }))(recorded('thread-wait'));
			const server = yield* serveMcp({ t3_thread_wait: { result: textOnly }, t3_thread_read: { result: recorded('thread-read'), asEvents: true } });
			const [waited, read] = yield* Effect.all([
				T3.use((t3) => t3.waitThread({ threadId: '4bdef28a-d833-4584-89e6-bff19d0fbcc4', timeoutMs: 1 })),
				T3.use((t3) => t3.readThread({ threadId: '4bdef28a-d833-4584-89e6-bff19d0fbcc4', limit: 2 })),
			]).pipe(Effect.provide(t3With(server.url)));

			assert.deepStrictEqual(waited, { threadId: '4bdef28a-d833-4584-89e6-bff19d0fbcc4', runId: 'run:thread:4bdef28a-d833-4584-89e6-bff19d0fbcc4:ordinal:2', status: 'completed', timedOut: false });
			assert.deepStrictEqual(
				{ itemCount: read.thread.itemCount, items: read.items },
				{
					itemCount: 79,
					items: [
						{ type: 'user_message', updatedAt: '2026-10-07T06:01:07.428Z' },
						{ type: 'assistant_message', updatedAt: '2026-10-07T06:24:44.007Z' },
					],
				},
			);
		}),
	);

	it.effect("fails with T3's failure code when a tool refuses, and Permanent on a JSON-RPC error", () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({
				t3_thread_read: { result: recorded('error-thread-not-found') },
				t3_thread_wait: { error: { code: -32602, message: "Invalid parameters for tool 't3_thread_wait': Expected a number" } },
			});
			const [refused, invalid] = yield* Effect.all([
				T3.use((t3) => t3.readThread({ threadId: 'thread-gone' })).pipe(Effect.flip),
				T3.use((t3) => t3.waitThread({ threadId: 'thread-gone', timeoutMs: 1 })).pipe(Effect.flip),
			]).pipe(Effect.provide(t3With(server.url)));

			assert.deepStrictEqual(refused, new T3ToolFailure({ tool: 't3_thread_read', code: 'thread_not_found', message: 'Thread thread-gone is no longer available.' }));
			assert.deepStrictEqual(invalid, new Permanent({ message: "T3 refused tools/call: Invalid parameters for tool 't3_thread_wait': Expected a number (-32602)" }));
		}),
	);

	it.effect('opens a new session once T3 forgot the old one, e.g. after it restarted', () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({ t3_project_list: { result: recorded('project-list') } });

			yield* Effect.gen(function* () {
				const t3 = yield* T3;

				yield* t3.listProjects;
				server.forgetSessions();
				yield* t3.listProjects;
			}).pipe(Effect.provide(t3With(server.url)));

			assert.deepStrictEqual(
				server.seen().map(({ method, sessionId }) => `${method} ${sessionId ?? '-'}`),
				[
					'initialize -',
					'notifications/initialized session-1',
					'tools/call session-1',
					'tools/call session-1',
					'initialize -',
					'notifications/initialized session-2',
					'tools/call session-2',
				],
			);
		}),
	);

	it.effect('fails T3Unauthorized at once, without retrying, when T3 rejects the token', () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({});
			const exit = yield* T3.use((t3) => t3.ping).pipe(Effect.provide(t3With(server.url, 'eyJ2IjoxfQ.cmV2b2tlZA')), Effect.exit);

			assert.deepStrictEqual(
				exit,
				Exit.fail(new T3Unauthorized({ message: 'T3 answered HTTP 401: {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}' })),
			);
			assert.deepStrictEqual(server.seen(), [{ method: 'initialize' }]);
		}),
	);

	it.effect("launches a thread with T3's default model from its settings", () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({ t3_thread_launch: launchTool });
			const launched = yield* T3.use((t3) => t3.launchThread(launchInput)).pipe(Effect.provide(t3With(server.url)));

			assert.deepStrictEqual(launched, {
				threadId: '7c0e1f52-9a3b-4d8e-b6f1-2a4c5d6e7f80',
				projectId: '8eb2d7d4-2f61-4230-bbcd-38f64a67f7bd',
				runId: 'run:thread:7c0e1f52-9a3b-4d8e-b6f1-2a4c5d6e7f80:ordinal:1',
				status: 'preparing',
			});
		}),
	);

	it.effect('fails Permanent without calling T3 when its settings have no default model', () =>
		Effect.gen(function* () {
			const server = yield* serveMcp({ t3_thread_launch: launchTool });
			const missing = join(import.meta.dirname, 'fixtures/t3/no-such-settings.json');
			const failed = yield* T3.use((t3) => t3.launchThread(launchInput)).pipe(Effect.provide(t3With(server.url, token, missing)), Effect.flip);

			assert.deepStrictEqual(failed, new Permanent({ message: `T3's settings file ${missing} does not exist: set a default model in T3` }));
			assert.deepStrictEqual(server.seen(), []);
		}),
	);
});
