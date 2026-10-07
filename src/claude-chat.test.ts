import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option, Stream } from 'effect';
import { ClaudeChat, type ChatTurn } from './claude-chat.ts';
import { type FakeClaudeAnswer, type FakeClaudeRun, fakeClaude, flagValue } from './claude-chat-fake.ts';
import { Prompts } from './prompts.ts';

const makeClaude = (answer: (run: FakeClaudeRun) => FakeClaudeAnswer) =>
	Effect.gen(function* () {
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), 'sapphire-agent-claude-'))),
			(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
		);
		const fake = yield* fakeClaude(join(dir, 'claude'), answer);
		const claude = yield* ClaudeChat.pipe(Effect.provide(ClaudeChat.layer.pipe(Layer.provide([fake.layer, Prompts.layer]))));

		return { claude, fake };
	});

const project = { team: 'Hivemind', repo: '/home/dev/hivemind', labelReposDirectory: '/home/dev/hivemind-repos' };

const newTurn: ChatTurn = { sessionId: '8b0f5c1e-2d9a-4c3b-9f1e-6a7d5e4c3b2a', parent: Option.none(), prompt: 'hello', cwd: project.repo, project };

describe('ClaudeChat', () => {
	it.effect('streams the text pieces of a turn without what its subagents write, a message after a tool call on a paragraph of its own', () =>
		Effect.gen(function* () {
			const { claude } = yield* makeClaude(() => ({ text: ['Let me ', 'look.'], afterToolCall: ['It is ', 'done.'] }));
			const pieces = yield* claude.turn(newTurn).pipe(Stream.runCollect);

			assert.deepStrictEqual(pieces, ['Let me ', 'look.', '\n\nIt is ', 'done.']);
		}).pipe(Effect.scoped),
	);

	it.effect('fails a turn that Claude ends with an error result, after the text it wrote', () =>
		Effect.gen(function* () {
			const { claude } = yield* makeClaude(() => ({ text: ['Working on it'], failure: 'API Error: 529 Overloaded' }));
			const pieces: Array<string> = [];
			const error = yield* claude.turn(newTurn).pipe(
				Stream.runForEach((piece) => Effect.sync(() => pieces.push(piece))),
				Effect.flip,
			);

			assert.deepStrictEqual([pieces, error.message], [['Working on it'], 'Claude failed: API Error: 529 Overloaded']);
		}).pipe(Effect.scoped),
	);

	it.effect("runs a project topic's turn in the directory it is given, with the project appended to the chat prompt", () =>
		Effect.gen(function* () {
			const { claude, fake } = yield* makeClaude(() => ({ text: ['On it.'] }));
			const prompts = yield* Prompts.pipe(Effect.provide(Prompts.layer));

			yield* claude.turn(newTurn).pipe(Stream.runDrain);

			const [run] = fake.runs;
			const prompt = flagValue(run.args, '--append-system-prompt') ?? '';

			assert.strictEqual(run.cwd, project.repo);
			assert.isTrue(prompt.startsWith(prompts.chat));
			assert.include(prompt, 'project Hivemind. You run in its repo, /home/dev/hivemind.');
			assert.include(prompt, '/home/dev/hivemind-repos/<name>');
		}).pipe(Effect.scoped),
	);

	it.effect('reads what a turn runs with from its system/init event and kills Claude before it answers', () =>
		Effect.gen(function* () {
			const { claude, fake } = yield* makeClaude(() => ({ text: ['pong'], hang: true }));
			const init = yield* claude.init;
			const [run] = fake.runs;

			assert.deepStrictEqual(
				{ model: init.model, outputStyle: init.output_style, permissionMode: init.permissionMode },
				{ model: 'claude-opus-5-5[1m]', outputStyle: 'ADHD', permissionMode: 'bypassPermissions' },
			);
			assert.isTrue(run.killed);
			assert.strictEqual(flagValue(run.args, '--setting-sources'), 'user,project,local');
			assert.notInclude(run.args, '--bare');
		}).pipe(Effect.scoped),
	);
});
