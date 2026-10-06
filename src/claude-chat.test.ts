import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option, Stream } from 'effect';
import { ClaudeChat } from './claude-chat.ts';
import { type FakeClaudeAnswer, type FakeClaudeRun, fakeClaude, flagValue } from './claude-chat-fake.ts';
import { projectSlug } from './claude-transcript.ts';
import { AppConfig } from './config.ts';
import { Prompts } from './prompts.ts';

const makeClaude = (answer: (run: FakeClaudeRun) => FakeClaudeAnswer) =>
	Effect.gen(function* () {
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), 'sapphire-agent-claude-'))),
			(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
		);
		const fake = yield* fakeClaude(join(dir, 'claude'), answer);
		const claude = yield* ClaudeChat.pipe(Effect.provide(ClaudeChat.layer.pipe(Layer.provide([fake.layer, Prompts.layer, NodeFileSystem.layer, AppConfig.layerTest(dir)]))));
		const transcript = (sessionId: string | null) => join(dir, 'claude', 'projects', projectSlug(homedir()), `${sessionId}.jsonl`);

		return { claude, fake, transcript };
	});

const newTurn = { sessionId: '8b0f5c1e-2d9a-4c3b-9f1e-6a7d5e4c3b2a', parent: Option.none<string>(), prompt: 'hello' };

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

	it.effect('keeps a session warm in a throwaway fork of it and deletes the fork’s transcript, leaving the session’s', () =>
		Effect.gen(function* () {
			const { claude, fake, transcript } = yield* makeClaude(() => ({ text: ['pong'] }));

			yield* claude.turn(newTurn).pipe(Stream.runDrain);
			yield* claude.keepAlive(newTurn.sessionId);

			const [, keepAlive] = fake.runs;
			const fork = flagValue(keepAlive.args, '--session-id');

			assert.deepStrictEqual(
				[keepAlive.prompt, flagValue(keepAlive.args, '--resume'), keepAlive.args.includes('--fork-session'), fork === newTurn.sessionId],
				['ping', newTurn.sessionId, true, false],
			);
			assert.deepStrictEqual([existsSync(transcript(newTurn.sessionId)), existsSync(transcript(fork))], [true, false]);
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
