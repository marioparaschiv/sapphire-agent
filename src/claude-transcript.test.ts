import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { onTestFinished } from 'vitest';
import { transcriptEntries as entries, transcriptLines, writeTranscript } from './claude-transcript-fixture.ts';
import { ClaudeTranscript, type TranscriptSession } from './claude-transcript.ts';
import { AppConfig } from './config.ts';

const session: TranscriptSession = { id: '9b2f7c1e-4d3a-4e8b-a6f0-1c2d3e4f5a6b', cwd: '/home/dev/.t3/worktrees/telecord/mario-tel-435-compression-stops-leaking' };

const claudeDirectory = () => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-transcript-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	return dir;
};

const transcriptLayer = (dir: string) => ClaudeTranscript.layer.pipe(Layer.provide(AppConfig.layerTest(dir)), Layer.provide(NodeServices.layer));

describe('ClaudeTranscript', () => {
	it.effect('finds the transcript of a cwd whose directory name Claude Code shortened', () => {
		const dir = claudeDirectory();
		const long: TranscriptSession = { ...session, cwd: `/home/dev/.t3/worktrees/telecord/mario-tel-435-${'compression-stops-leaking-an-open-file-'.repeat(5)}` };

		writeTranscript(join(dir, 'claude'), long, entries.toolCall(long, 118_400));

		return ClaudeTranscript.use((transcript) => transcript.contextTokens(long, null)).pipe(
			Effect.map((tokens) => assert.deepStrictEqual(tokens, Option.some(118_400))),
			Effect.provide(transcriptLayer(dir)),
		);
	});

	it.effect("reads the context of the latest assistant entry, the session's or its subagent's", () => {
		const dir = claudeDirectory();
		const claudeConfigDirectory = join(dir, 'claude');
		const agentId = 'a4f29c81d03e5b7a6';

		return Effect.gen(function* () {
			const transcript = yield* ClaudeTranscript;

			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.none());

			writeTranscript(claudeConfigDirectory, session, [...entries.prompt(session, '/orchestrate Linear epic TEL-435 autonomously'), ...entries.toolCall(session, 118_400), ...entries.toolCall(session, 131_250)]);
			writeTranscript(claudeConfigDirectory, session, [...entries.prompt(session, 'Implement TEL-436.'), ...entries.toolCall(session, 251_300)], agentId);

			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.some(131_250));
			assert.deepStrictEqual(yield* transcript.contextTokens(session, agentId), Option.some(251_300));
			assert.deepStrictEqual(yield* transcript.contextTokens(session, 'b0c1d2e3f4a5b6c7d'), Option.none());
		}).pipe(Effect.provide(transcriptLayer(dir)));
	});

	it.effect('reads a transcript whole only once, then only what was appended, up to its last complete line', () => {
		const dir = claudeDirectory();
		const prompt = entries.prompt(session, '/orchestrate Linear epic TEL-435 autonomously');
		const path = writeTranscript(join(dir, 'claude'), session, [...prompt, ...entries.toolCall(session, 262_000)]);
		const later = transcriptLines(entries.toolCall(session, 96_500));

		return Effect.gen(function* () {
			const transcript = yield* ClaudeTranscript;

			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.some(262_000));

			// Blanked in place: read again, it would hold no context at all.
			writeFileSync(path, readFileSync(path).map((byte) => (byte === 0x0a ? byte : 0x20)));
			appendFileSync(path, transcriptLines(prompt));
			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.some(262_000));

			appendFileSync(path, later.slice(0, 200));
			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.some(262_000));

			appendFileSync(path, later.slice(200));
			assert.deepStrictEqual(yield* transcript.contextTokens(session, null), Option.some(96_500));
		}).pipe(Effect.provide(transcriptLayer(dir)));
	});
});
