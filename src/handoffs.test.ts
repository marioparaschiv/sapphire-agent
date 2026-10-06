import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { onTestFinished } from 'vitest';
import { transcriptEntries as entries } from './claude-transcript-fixture.ts';
import type { TranscriptSession } from './claude-transcript.ts';
import { type Harness, makeHarness } from './test-harness.ts';

// A hook payload as Claude Code writes it on stdin; `agent_id` when a subagent fires it.
const claudeHook = (event: string, sessionId: string, fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		session_id: sessionId,
		transcript_path: `/home/dev/.claude/projects/-tmp/${sessionId}.jsonl`,
		cwd: '/tmp',
		permission_mode: 'bypassPermissions',
		hook_event_name: event,
		...fields,
	});

const bashHook = (sessionId: string, agentId?: string) =>
	claudeHook('PostToolUse', sessionId, {
		tool_name: 'Bash',
		tool_input: { command: 'npm test', description: 'Run the tests' },
		tool_response: { stdout: 'Tests  271 passed (271)', stderr: '', interrupted: false },
		tool_use_id: `toolu_${randomUUID()}`,
		...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'general-purpose' }),
	});

const docPath = (identifier: string, id: string) => {
	const path = join(tmpdir(), `sapphire-agent-handoff-${identifier}-${id}.md`);

	onTestFinished(() => rmSync(path, { force: true }));

	return path;
};

const waiting = (h: Harness) => h.ctl('status').pipe(Effect.map((lines) => lines.filter((line) => line.startsWith('request '))));

const typed = (h: Harness) => h.herdr.prompts().map(({ text }) => text);

const noticesOf = (h: Harness, identifier: string, purpose: string) => h.notices(identifier).filter(({ marker }) => marker.startsWith(`${purpose}:`));

// The user has written to the bot, so it opens the epic's topic.
const greet = (h: Harness) => h.telegram.write({ from: h.telegramUser, text: 'hi' });

const epicTopicTexts = (h: Harness) => {
	const topic = h.telegram.topics().find(({ title }) => title !== '📁 Test');

	return h.telegram.sent.filter(({ topicId }) => topicId === topic?.topicId).map(({ text }) => text);
};

const ok = { code: 0, stdout: '', stderr: '' };

describe('handoffs', () => {
	it.effect('hands the orchestrator over to a fresh session once its context reaches the threshold, one step each, across restarts', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const session: TranscriptSession = { id: run.session.id, cwd: run.worktreePath };
			const path = docPath('TEST-10', session.id);
			const started = [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 249_999)];
			const full = [...started, ...entries.toolCall(session, 250_000)];

			h.writeTranscript(session, started);
			assert.deepStrictEqual(yield* h.hook('claude', bashHook(session.id), run.paneId), ok);
			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('Stop', session.id, { stop_hook_active: false }), run.paneId), ok);
			yield* h.tick;
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(typed(h), []);

			h.writeTranscript(session, full);
			assert.deepStrictEqual(yield* h.hook('claude', bashHook(session.id), run.paneId), ok);
			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('Stop', session.id, { stop_hook_active: false }), run.paneId), ok);
			assert.deepStrictEqual(yield* waiting(h), [`request 1: handoff TEST-10: ${session.id}`]);

			yield* h.tick;
			assert.deepStrictEqual(yield* h.hook('claude', bashHook(session.id), run.paneId), ok);
			yield* h.tick;
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(typed(h), [`/handoff Write the document to ${path}. The next session continues this run where you stopped.`]);

			yield* h.restart;
			h.herdr.setAgentStatus(run.paneId, 'idle');
			yield* h.tick;
			assert.deepStrictEqual(typed(h).length, 1);

			writeFileSync(path, '# Handoff\n\nTEST-10: slice 2 of 3 is next.\n');
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;
			assert.deepStrictEqual(typed(h).slice(1), ['/clear']);

			const cleared = randomUUID();

			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('SessionStart', cleared, { source: 'clear' }), run.paneId), ok);
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;
			assert.deepStrictEqual(typed(h).slice(2), [`Read ${path} and continue; run its suggested skills`]);
			assert.deepStrictEqual(
				(yield* h.runs).map(({ session, handoff }) => ({ session: session?.id, handoff })),
				[{ session: cleared, handoff: { sessionId: session.id, step: 'resumed' } }],
			);
		}),
	);

	it.effect('posts one notice in the epic topic and clears nothing when the handoff doc is still missing startTimeoutSeconds after the turn ended', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });
			const session: TranscriptSession = { id: run.session.id, cwd: run.worktreePath };
			const path = docPath('TEST-10', session.id);

			greet(h);
			h.writeTranscript(session, [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 263_400)]);
			assert.deepStrictEqual(yield* h.hook('claude', claudeHook('Stop', session.id, { stop_hook_active: false }), run.paneId), ok);
			yield* h.tick;
			yield* TestClock.adjust('299 seconds');
			yield* h.tick;
			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'handoffMissing'), []);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* TestClock.adjust('5 minutes');
			yield* h.tick;

			const text = `📝 **TEST-10 wrote no handoff doc** 5 min after its context passed 250000 tokens, so its session was not cleared.\n- Expected: \`${path}\`\nNext: Look at the agent in its tab.`;

			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'handoffMissing'), [{ marker: `handoffMissing:${session.id}`, text, sent: true }]);
			assert.lengthOf(
				epicTopicTexts(h).filter((sent) => sent.startsWith('📝 TEST-10 wrote no handoff doc')),
				1,
			);
			assert.deepStrictEqual(typed(h), [`/handoff Write the document to ${path}. The next session continues this run where you stopped.`]);
		}),
	);

	it.effect('tells a subagent once, in its hook output, to hand off at the threshold, and posts one notice past 1.2 times it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const session: TranscriptSession = { id: run.session.id, cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';
			const path = docPath('TEST-10', agentId);
			const transcript = entries.prompt(session, 'Implement slice 2 of TEST-10.');
			const subagentAt = (context: number) => {
				transcript.push(...entries.toolCall(session, context));
				h.writeSubagentTranscript(session, agentId, transcript);

				return h.hook('claude', bashHook(session.id, agentId), run.paneId);
			};

			greet(h);
			yield* h.tick;
			h.writeTranscript(session, [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 263_400)]);

			assert.deepStrictEqual(yield* subagentAt(249_999), ok);

			const told = yield* subagentAt(250_000);

			assert.deepStrictEqual(told.code, 0);
			assert.deepStrictEqual(JSON.parse(told.stdout), {
				hookSpecificOutput: {
					hookEventName: 'PostToolUse',
					additionalContext: `Your context is full. Stop your current work now. Write a handoff document to ${path} by following ${join(h.dir, 'claude', 'skills', 'handoff', 'SKILL.md')}, then end your turn with exactly this line: HANDOFF ${path}`,
				},
			});
			assert.deepStrictEqual(yield* subagentAt(271_000), ok);
			assert.deepStrictEqual(yield* subagentAt(299_999), ok);
			yield* h.tick;
			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'subagentOverContext'), []);

			assert.deepStrictEqual(yield* subagentAt(300_000), ok);
			assert.deepStrictEqual(yield* subagentAt(312_000), ok);
			yield* h.tick;

			const text = `🧠 **A subagent of TEST-10 did not hand off**: its context is at 300000 tokens. It keeps running.\n- Agent: \`${agentId}\`\nNext: Look at the agent in its tab.`;

			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'subagentOverContext'), [{ marker: `subagentOverContext:${agentId}`, text, sent: true }]);
			assert.lengthOf(
				epicTopicTexts(h).filter((sent) => sent.startsWith('🧠 A subagent of TEST-10 did not hand off')),
				1,
			);
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(typed(h), []);
		}),
	);

	it.effect("adds nothing to a subagent's tool call while the service is down, and tells it on the next call", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'working' });
			const session: TranscriptSession = { id: run.session.id, cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';

			docPath('TEST-10', agentId);
			h.writeSubagentTranscript(session, agentId, [...entries.prompt(session, 'Implement slice 2 of TEST-10.'), ...entries.toolCall(session, 254_000)]);
			yield* h.stop;
			assert.deepStrictEqual(yield* h.hook('claude', bashHook(session.id, agentId), run.paneId), ok);

			yield* h.restart;

			const told = yield* h.hook('claude', bashHook(session.id, agentId), run.paneId);

			assert.include(told.stdout, `HANDOFF ${join(tmpdir(), `sapphire-agent-handoff-TEST-10-${agentId}.md`)}`);
		}),
	);
});
