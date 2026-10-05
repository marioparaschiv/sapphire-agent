import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { onTestFinished } from 'vitest';
import { transcriptEntries as entries, type TranscriptSession, writeTranscript } from './claude-transcript-fixture.ts';
import { ClaudeTranscript } from './claude-transcript.ts';
import { AppConfig } from './config.ts';

const session: TranscriptSession = { id: '9b2f7c1e-4d3a-4e8b-a6f0-1c2d3e4f5a6b', cwd: '/home/dev/.herdr/worktrees/telecord/mario-tel-435-compression-stops-leaking' };

const question = 'TEL-435: Keep the old cache or drop it?';

const claudeDirectory = () => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-transcript-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	return dir;
};

const pendingMessage = (dir: string, of: TranscriptSession) =>
	ClaudeTranscript.use((transcript) => transcript.pendingMessage(of, 'hivemind-ts-59')).pipe(
		Effect.provide(ClaudeTranscript.layer.pipe(Layer.provide(AppConfig.layerTest(dir)), Layer.provide(NodeServices.layer))),
	);

describe('ClaudeTranscript', () => {
	it.effect('finds the message the session waits on a reply to, until the reply-to session or the user answers', () => {
		const dir = claudeDirectory();
		const claudeConfigDirectory = join(dir, 'claude');
		const asked = [
			...entries.prompt(session, '/orchestrate Linear epic TEL-435 autonomously, reply-to hivemind-ts-59'),
			...entries.sentMessage(session, 'tel-434', 'TEL-435: Is your migration merged yet?'),
			...entries.peerMessage(session, 'tel-434', 'TEL-434: Yes.'),
			...entries.sentMessage(session, 'hivemind-ts-59', question),
			...entries.sentMessage(session, 'tel-434', 'TEL-435: The cache moves to the new path.'),
			...entries.text(session, 'Asked hivemind-ts-59; waiting for the reply.'),
			...entries.taskNotification(session),
			...entries.text(session, 'The review agent is done; still waiting for the reply on the cache.'),
		];

		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* pendingMessage(dir, session), Option.none());

			writeTranscript(claudeConfigDirectory, session, asked);
			assert.deepStrictEqual(yield* pendingMessage(dir, session), Option.some(question));

			writeTranscript(claudeConfigDirectory, session, [...asked, ...entries.peerMessage(session, 'hivemind-ts-59', 'TEL-435: Drop it.')]);
			assert.deepStrictEqual(yield* pendingMessage(dir, session), Option.none());

			writeTranscript(claudeConfigDirectory, session, [...asked, ...entries.prompt(session, 'Drop it.')]);
			assert.deepStrictEqual(yield* pendingMessage(dir, session), Option.none());
		});
	});

	it.effect('finds the transcript of a cwd whose directory name Claude Code shortened', () => {
		const dir = claudeDirectory();
		const long: TranscriptSession = { ...session, cwd: `/home/dev/.herdr/worktrees/telecord/mario-tel-435-${'compression-stops-leaking-an-open-file-'.repeat(5)}` };

		writeTranscript(join(dir, 'claude'), long, entries.sentMessage(long, 'hivemind-ts-59', question));

		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* pendingMessage(dir, long), Option.some(question));
		});
	});
});
