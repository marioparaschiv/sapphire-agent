import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
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

const sent = (h: Harness) => h.t3.sends.pipe(Effect.map((sends) => sends.map(({ message }) => message)));

const noticesOf = (h: Harness, identifier: string, purpose: string) => h.notices(identifier).filter(({ marker }) => marker.startsWith(`${purpose}:`));

const ok = { code: 0, stdout: '', stderr: '' };

// The payload as a session in `cwd` sends it: a T3 thread's agent is known only by the directory it works in.
const from = (cwd: string, payload: string) => JSON.stringify({ ...JSON.parse(payload), cwd, transcript_path: `/home/dev/.claude/projects/-${cwd.replace(/[^A-Za-z0-9]/g, '-')}.jsonl` });

describe('handoffs', () => {
	it.effect('hands a run over to a second thread on the same worktree and branch, settles the first, and keeps one run', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const path = docPath('TEST-10', session.id);

			yield* h.t3.setRunStatus(run.threadId, 'running');
			h.writeTranscript(session, [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 251_000)]);
			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, claudeHook('SessionStart', session.id, { source: 'startup' }))), ok);
			yield* h.tick;
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.session?.id),
				[session.id],
			);

			assert.deepStrictEqual(yield* h.hook('claude', from(join(run.worktreePath, 'src'), bashHook(session.id))), ok);
			assert.deepStrictEqual(yield* waiting(h), [`request 2: handoff TEST-10: ${session.id}`]);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.t3.sends).map(({ threadId, message, mode, clientRequestId }) => [threadId, message, mode, clientRequestId]),
				[[run.threadId, `/handoff Write the document to ${path}. The next session continues this run where you stopped.`, 'auto', `handoff-${session.id}`]],
			);
			assert.lengthOf(yield* h.t3.launches, 1);

			writeFileSync(path, '# Handoff\n\nTEST-10: slice 2 of 3 is next.\n');
			yield* h.tick;
			assert.lengthOf(yield* h.t3.launches, 1, 'the thread still works, so it is not handed over yet');

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			h.crashAtJournalWrite(1);
			yield* h.tick;
			assert.isTrue(h.crashed());
			assert.lengthOf(yield* h.t3.launches, 2, 'the process died right after the launch');
			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			const launches = yield* h.t3.launches;
			const [after] = yield* h.runs;

			assert.lengthOf(launches, 2, 'the thread launched before the crash is found by its title');
			assert.deepStrictEqual(launches[1], {
				projectId: launches[0].projectId,
				title: 'TEST-10 (2) Plugin settings sync',
				message: `Read ${path} and continue; run its suggested skills`,
				workspaceStrategy: { type: 'existing_worktree', worktreePath: run.worktreePath, branch: run.branch },
				runtimeMode: 'full-access',
			});
			assert.lengthOf(yield* h.runs, 1);
			assert.notStrictEqual(after.threadId, run.threadId);
			assert.isNotNull(after.threadId);
			assert.deepStrictEqual([after.epicId, after.status, after.worktreePath, after.branch, after.claimedAt, after.handoff], [epic.id, 'running', run.worktreePath, run.branch, run.claimedAt, { sessionId: session.id, step: 'resumed' }]);
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(run.threadId), ({ settled }) => settled), Option.some(true));
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(after.threadId), ({ settled, worktreePath, branch }) => [settled, worktreePath, branch]), Option.some([false, run.worktreePath, run.branch]));

			const next = randomUUID();

			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, claudeHook('SessionStart', next, { source: 'startup' }))), ok);
			yield* h.tick;
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => [found.threadId, found.session?.id]),
				[[after.threadId, next]],
			);
		}),
	);

	it.effect('sends /handoff once when the process dies at any journal write of the request', () =>
		Effect.gen(function* () {
			for (let nth = 1; nth <= 2; nth += 1) {
				const h = yield* makeHarness();
				const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
				const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };

				docPath('TEST-10', session.id);
				yield* h.t3.setRunStatus(run.threadId, 'running');
				h.writeTranscript(session, [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 251_000)]);
				yield* h.hook('claude', from(run.worktreePath, claudeHook('SessionStart', session.id, { source: 'startup' })));
				yield* h.tick;
				yield* h.hook('claude', from(run.worktreePath, bashHook(session.id)));

				h.crashAtJournalWrite(nth);
				yield* h.tick;
				assert.isTrue(h.crashed(), `crash at journal write ${nth}`);
				yield* h.restart;
				yield* h.tick;

				assert.lengthOf(yield* sent(h), 1, `crash at journal write ${nth}`);
				assert.deepStrictEqual(yield* waiting(h), [], `crash at journal write ${nth}`);
				assert.deepStrictEqual(
					(yield* h.runs).map((found) => found.handoff),
					[{ sessionId: session.id, step: 'requested' }],
					`crash at journal write ${nth}`,
				);
			}
		}),
	);

	it.effect("tells a run's subagent past the threshold to hand off only from inside its worktree, in its hook output", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';
			const path = docPath('TEST-10', agentId);

			h.writeSubagentTranscript(session, agentId, [...entries.prompt(session, 'Implement slice 2 of TEST-10.'), ...entries.toolCall(session, 250_000)]);

			const elsewhere = yield* h.hook('claude', from(h.repo, bashHook(session.id, agentId)));
			const told = yield* h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId)));

			assert.deepStrictEqual(elsewhere, ok);
			assert.deepStrictEqual(JSON.parse(told.stdout), {
				hookSpecificOutput: {
					hookEventName: 'PostToolUse',
					additionalContext: `Your context is full. Stop your current work now. Write a handoff document to ${path} by following ${join(h.dir, 'claude', 'skills', 'handoff', 'SKILL.md')}, then end your turn with exactly this line: HANDOFF ${path}`,
				},
			});
			assert.deepStrictEqual(yield* h.t3.sends, []);
		}),
	);

	it.effect('posts one notice on the epic and launches no new thread when the handoff doc is still missing startTimeoutSeconds after the turn ended', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const path = docPath('TEST-10', session.id);

			h.writeTranscript(session, [...entries.prompt(session, '/orchestrate Linear epic TEST-10 autonomously'), ...entries.toolCall(session, 263_400)]);
			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, claudeHook('SessionStart', session.id, { source: 'startup' }))), ok);
			yield* h.tick;
			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, bashHook(session.id))), ok);
			yield* h.tick;
			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.tick;
			yield* TestClock.adjust('299 seconds');
			yield* h.tick;
			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'handoffMissing'), []);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const text = `📝 **TEST-10 wrote no handoff doc** 5 min after its context passed 250000 tokens, so no new thread took over.\n- Expected: \`${path}\`\nNext: Look at the agent in its T3 thread.`;

			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'handoffMissing'), [{ marker: `handoffMissing:${session.id}`, text, sent: true }]);
			assert.deepStrictEqual(
				h.epicMarkers(run.epicId).filter((marker) => marker.startsWith('handoffMissing:')),
				[`handoffMissing:${session.id}`],
			);
			assert.deepStrictEqual(yield* sent(h), [`/handoff Write the document to ${path}. The next session continues this run where you stopped.`]);
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);

	it.effect('tells a subagent once, in its hook output, to hand off at the threshold, and posts one notice past 1.2 times it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';
			const path = docPath('TEST-10', agentId);
			const transcript = entries.prompt(session, 'Implement slice 2 of TEST-10.');
			const subagentAt = (context: number) => {
				transcript.push(...entries.toolCall(session, context));
				h.writeSubagentTranscript(session, agentId, transcript);

				return h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId)));
			};

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

			const text = `🧠 **A subagent of TEST-10 did not hand off**: its context is at 300000 tokens. It keeps running.\n- Agent: \`${agentId}\`\nNext: Look at the agent in its T3 thread.`;

			assert.deepStrictEqual(noticesOf(h, 'TEST-10', 'subagentOverContext'), [{ marker: `subagentOverContext:${agentId}`, text, sent: true }]);
			assert.deepStrictEqual(
				h.epicMarkers(run.epicId).filter((marker) => marker.startsWith('subagentOverContext:')),
				[`subagentOverContext:${agentId}`],
			);
			assert.deepStrictEqual(yield* waiting(h), []);
			assert.deepStrictEqual(yield* sent(h), []);
		}),
	);

	it.effect("adds nothing to a subagent's tool call while the service is down, and tells it on the next call", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';
			const path = docPath('TEST-10', agentId);

			h.writeSubagentTranscript(session, agentId, [...entries.prompt(session, 'Implement slice 2 of TEST-10.'), ...entries.toolCall(session, 254_000)]);
			yield* h.stop;
			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId))), ok);

			yield* h.restart;

			const told = yield* h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId)));

			assert.include(told.stdout, `HANDOFF ${path}`);
		}),
	);

	it.effect('lets a tool call through when its transcript cannot be read, and checks again on the next call', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const session: TranscriptSession = { id: randomUUID(), cwd: run.worktreePath };
			const agentId = 'a4f29c81d03e5b7a6';
			const transcriptEntries = [...entries.prompt(session, 'Implement slice 2 of TEST-10.'), ...entries.toolCall(session, 254_000)];
			const transcript = h.writeSubagentTranscript(session, agentId, transcriptEntries);
			const path = docPath('TEST-10', agentId);

			rmSync(transcript);
			mkdirSync(transcript);
			assert.deepStrictEqual(yield* h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId))), ok);

			rmSync(transcript, { recursive: true });
			h.writeSubagentTranscript(session, agentId, transcriptEntries);

			const told = yield* h.hook('claude', from(run.worktreePath, bashHook(session.id, agentId)));

			assert.include(told.stdout, `HANDOFF ${path}`);
		}),
	);
});
