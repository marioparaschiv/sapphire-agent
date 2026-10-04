import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ClaimStore } from './claims.ts';
import { configSchema } from './config.ts';
import { Dispatcher } from './dispatcher.ts';
import { FakeLinear, UNBOUND_TEAM_ID, unboundStates } from './fixtures/linear-server.ts';
import { GitHub, ON_BEHALF_OF_CLAUDE, type PullRequest } from './github.ts';
import { LinearClient } from './linear.ts';
import type { DispatcherMessage, ResultFile, Run } from './protocol.ts';

const config = configSchema.parse({
	awaitingInputAfterSeconds: 180,
	startTimeoutSeconds: 300,
	staleAfterSeconds: 600,
	nudgeGraceSeconds: 600,
	maxRunSeconds: 5400,
	teams: { Unbound: { repo: '/srv/unbound', labelReposDirectory: '/srv/unbound-app' } },
});

async function harness(t: TestContext) {
	const linear = new FakeLinear();
	await linear.listen();
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-dispatcher-'));
	t.after(async () => {
		await linear.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const statePath = join(dir, 'claims.json');
	const harness = {
		linear,
		statePath,
		sent: [] as DispatcherMessage[],
		logs: [] as string[],
		now: 1_791_100_000_000,
		paused: false,
		pullRequest: undefined as PullRequest | undefined,
		// The review threads on the open PR, as GitHub would hold them.
		threads: [] as FakeThread[],
		// Every gh call, as the process would receive it.
		gh: [] as { args: string[]; input?: string }[],
		// gh calls whose arguments or stdin match fail like a GitHub outage.
		ghFails: undefined as RegExp | undefined,
		onSend: (_message: DispatcherMessage) => {},
		async dispatcher() {
			return new Dispatcher({
				config,
				linear: new LinearClient({ apiKey: 'lin_api_test', endpoint: linear.url }),
				claims: await ClaimStore.open(statePath),
				send: (message) => {
					harness.onSend(message);
					harness.sent.push(message);
				},
				github: new GitHub(async (args, input) => {
					harness.gh.push({ args, input });

					if (harness.ghFails?.test(`${args.join(' ')} ${input ?? ''}`)) {
						throw new Error('gh: HTTP 502');
					}

					if (args[0] === 'pr') {
						return JSON.stringify(harness.pullRequest ? [harness.pullRequest] : []);
					}

					return args[1] === 'graphql' ? JSON.stringify({ data: fakeGraphql(harness, JSON.parse(input ?? '')) }) : '{}';
				}),
				isPaused: async () => harness.paused,
				now: () => harness.now,
				log: (line) => harness.logs.push(line),
			});
		},
	};

	return harness;
}

type FakeThread = { id: string; isResolved: boolean; comments: { body: string; reviewBody?: string }[] };

// Answers the GraphQL operations GitHub.pendingThreads, replyToThread and resolveThread send, like GitHub would.
function fakeGraphql(
	h: { pullRequest: PullRequest | undefined; threads: FakeThread[] },
	{ query, variables }: { query: string; variables: Record<string, string> },
) {
	const operation = /^(?:query|mutation) (\w+)/.exec(query)?.[1];
	const thread = h.threads.find((candidate) => candidate.id === variables.threadId);

	switch (operation) {
		case 'PendingThreads': {
			const open = h.pullRequest?.state === 'OPEN' ? [h.pullRequest] : [];
			const nodes = h.threads.map(({ id, isResolved, comments }) => ({
				id,
				isResolved,
				comments: { nodes: comments.map(({ body, reviewBody }) => ({ body, pullRequestReview: { body: reviewBody ?? '' } })) },
			}));

			return { repository: { pullRequests: { nodes: open.map(({ url }) => ({ url, reviewThreads: { totalCount: nodes.length, nodes } })) } } };
		}

		case 'ReplyToThread':
			thread!.comments.push({ body: variables.body });

			return { addPullRequestReviewThreadReply: { comment: { id: `${thread!.id}-reply` } } };

		case 'ResolveThread':
			thread!.isResolved = true;

			return { resolveReviewThread: { thread: { isResolved: true } } };
	}

	throw new Error(`unexpected GraphQL operation: ${query}`);
}

const runFor = (identifier: string): Run => ({
	tabId: 'w1:t4',
	paneId: 'w1:p7',
	worktreePath: `/home/dev/.herdr/worktrees/unbound/mario-${identifier.toLowerCase()}`,
	branch: `mario/${identifier.toLowerCase()}`,
	githubRepo: 'marioparaschiv/unbound',
});

const stateId = (name: string) => unboundStates.find((state) => state.name === name)!.id;

const ghWrites = (h: { gh: { args: string[]; input?: string }[] }) =>
	h.gh
		.filter(({ args, input }) => args[0] === 'api' && !input?.startsWith('{"query":"query'))
		.map(({ args, input }) => ({ args, body: JSON.parse(input ?? '') }));

const result = (overrides: Partial<ResultFile> = {}): ResultFile => ({
	summary: 'Added settings sync.\n\n1. Synced plugin settings.',
	replies: [],
	flags: [],
	...overrides,
});

test('records the claim on disk before dispatching, and moves the epic only after the worker confirms', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-12', title: 'Plugin settings sync' });
	const dispatcher = await h.dispatcher();
	let claimOnDiskAtSend: unknown;
	h.onSend = () => {
		claimOnDiskAtSend = JSON.parse(readFileSync(h.statePath, 'utf8')).claims[0]?.status;
	};

	await dispatcher.tick();

	assert.equal(claimOnDiskAtSend, 'claimed');
	assert.equal(h.sent.length, 1);
	const [message] = h.sent;
	assert.equal(message.type, 'dispatch');
	assert.equal(message.job.repoPath, '/srv/unbound');
	assert.equal(message.job.branch, 'mario/unb-12-plugin-settings-sync');
	assert.equal(message.job.tabLabel, 'UNB-12 Plugin settings sync');
	assert.match(message.job.prompt, /^\/orchestrate the sub-issues of Linear epic UNB-12 \(https:\/\/linear\.app\/.+\) autonomously,/);
	assert.doesNotMatch(message.job.prompt, /\n/);
	assert.equal(h.linear.stateName(epic.id), 'Ready For Agent');
	assert.deepEqual(h.linear.mutations, []);

	await dispatcher.tick();
	assert.equal(h.sent.length, 1, 'a claimed epic is not dispatched twice');

	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-12') });

	assert.equal(h.linear.stateName(epic.id), 'Implementing');
	assert.deepEqual(h.linear.mutations, [`move ${epic.id} ${stateId('Implementing')}`]);
	assert.ok(h.linear.authorizations.has('lin_api_test'));
});

test('a restarted dispatcher re-attaches claims instead of dispatching them again', async (t) => {
	const h = await harness(t);
	const claimed = h.linear.addEpic({ identifier: 'UNB-20', title: 'Claimed before the crash' });
	const first = await h.dispatcher();
	await first.tick();
	const [dispatch] = h.sent;
	assert.equal(dispatch.type, 'dispatch');

	const second = await h.dispatcher();
	second.start();
	await second.tick();

	assert.deepEqual(
		h.sent.map((message) => message.type),
		['dispatch', 'watch'],
	);
	assert.deepEqual(h.sent[1], { type: 'watch', job: dispatch.job, run: undefined });
	assert.equal(h.linear.stateName(claimed.id), 'Ready For Agent');

	await second.handle({ type: 'started', epicId: claimed.id, run: runFor('UNB-20') });
	const third = await h.dispatcher();
	third.start();
	await third.tick();

	assert.deepEqual(h.sent[2], { type: 'watch', job: dispatch.job, run: runFor('UNB-20') });
	assert.equal(h.sent.length, 3);
});

test('an epic labelled with a repo runs in that repo under the label directory', async (t) => {
	const h = await harness(t);
	h.linear.addEpic({ identifier: 'UNB-30', title: 'Loader crash on iOS 26', labelIds: ['lbl-loader'] });
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();

	const [message] = h.sent;
	assert.equal(message.type, 'dispatch');
	assert.equal(message.job.repoPath, '/srv/unbound-app/loader-ios');
});

test('keeps at most maxInFlight epics in flight, in board order', async (t) => {
	const h = await harness(t);
	const second = h.linear.addEpic({ identifier: 'UNB-41', title: 'Second', sortOrder: 20 });
	const first = h.linear.addEpic({ identifier: 'UNB-40', title: 'First', sortOrder: 10 });
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();
	assert.deepEqual(
		h.sent.map((message) => message.job.epicId),
		[first.id],
	);

	await dispatcher.handle({ type: 'started', epicId: first.id, run: runFor('UNB-40') });
	await dispatcher.handle({ type: 'status', epicId: first.id, status: 'idle', tail: 'PR opened.' });
	await dispatcher.handle({ type: 'result', epicId: first.id, result: result() });
	h.pullRequest = { number: 88, url: 'https://github.com/marioparaschiv/unbound/pull/88', state: 'OPEN', author: { login: 'marioparaschiv' } };
	await dispatcher.tick();

	assert.equal(h.linear.stateName(first.id), 'To Review');
	assert.deepEqual(
		h.sent.map((message) => `${message.type} ${message.job.epicId}`),
		[`dispatch ${first.id}`, `close ${first.id}`, `dispatch ${second.id}`],
	);
});

const claimsOnDisk = (h: { statePath: string }) =>
	JSON.parse(readFileSync(h.statePath, 'utf8')).claims as { epicId: string; status: string; claimedAt: number }[];

test('flags an agent that sits idle as awaiting input, keeps its slot, and resumes it once it works again', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-50', title: 'Asking a question', sortOrder: 1 });
	h.linear.addEpic({ identifier: 'UNB-51', title: 'Queued behind it', sortOrder: 2 });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-50') });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '' });
	await dispatcher.handle({
		type: 'status',
		epicId: epic.id,
		status: 'idle',
		tail: 'Which auth provider should slice 2 use?\n❯',
	});

	h.now += 179_000;
	await dispatcher.tick();
	assert.equal(h.linear.comments.length, 0, 'still inside the quiet window');

	h.now += 1_000;
	await dispatcher.tick();

	assert.equal(h.linear.comments.length, 1);
	const [comment] = h.linear.comments;
	assert.equal(comment.issueId, epic.id);
	assert.match(comment.body, /\(`awaitingInput`\): the agent has been idle for 3 min before writing its result file/);
	assert.match(comment.body, /Reply to this comment and the reply is typed into the agent's pane/);
	assert.match(comment.body, /w1:t4/);
	assert.match(comment.body, /Which auth provider should slice 2 use\?/);
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.equal(claimsOnDisk(h)[0].status, 'awaitingInput');

	h.now += 600_000;
	await dispatcher.tick();
	assert.equal(h.linear.comments.length, 1, 'an epic awaiting input is reported once');
	assert.equal(h.sent.length, 1, 'an epic awaiting input still counts as in flight');

	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '' });
	assert.equal(claimsOnDisk(h)[0].status, 'running');
	assert.ok(h.logs.includes('UNB-50: agent is working again'));
});

test('an open PR alone does not end the run; the result file does, posted to the PR as Claude', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-55', title: 'PR while working' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-55') });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: 'Opening the PR' });
	h.pullRequest = { number: 91, url: 'https://github.com/marioparaschiv/unbound/pull/91', state: 'OPEN', author: { login: 'marioparaschiv' } };

	await dispatcher.tick();
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'idle', tail: 'Opened PR #91.' });
	await dispatcher.tick();
	assert.equal(h.linear.stateName(epic.id), 'Implementing', 'the PR is up but the agent has not written its result');
	assert.deepEqual(ghWrites(h), []);

	const flags = [
		{ path: 'src/sync.ts', line: 12, body: 'This retry loop has no backoff.' },
		{ path: 'src/settings.ts', line: 40, body: 'The settings type duplicates the schema.' },
	];
	await dispatcher.handle({ type: 'result', epicId: epic.id, result: result({ flags }) });
	await dispatcher.tick();

	assert.deepEqual(ghWrites(h), [
		{
			args: ['api', '--method', 'POST', 'repos/marioparaschiv/unbound/issues/91/comments', '--input', '-'],
			body: { body: `Added settings sync.\n\n1. Synced plugin settings.\n\nReady for review, @marioparaschiv.\n\n${ON_BEHALF_OF_CLAUDE}` },
		},
		{
			args: ['api', '--method', 'POST', 'repos/marioparaschiv/unbound/pulls/91/reviews', '--input', '-'],
			body: {
				event: 'COMMENT',
				body: `Self-review findings I did not fix in this PR.\n\n${ON_BEHALF_OF_CLAUDE}`,
				comments: flags.map((flag) => ({ ...flag, side: 'RIGHT', body: `${flag.body}\n\n${ON_BEHALF_OF_CLAUDE}` })),
			},
		},
	]);
	assert.equal(h.linear.stateName(epic.id), 'To Review');
	assert.deepEqual(h.sent.at(-1), { type: 'close', job: h.sent[0].job, run: runFor('UNB-55') });
	assert.equal(claimsOnDisk(h)[0].status, 'ended');

	await dispatcher.tick();
	assert.equal(ghWrites(h).length, 2, 'nothing is posted twice');
});

test('posts no review without flags, and a restart mid-way never posts the summary twice', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-56', title: 'Crash while posting' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-56') });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'done', tail: 'Done.' });
	await dispatcher.handle({
		type: 'result',
		epicId: epic.id,
		result: result({ flags: [{ path: 'src/a.ts', line: 3, body: 'Rename this.' }] }),
	});
	h.pullRequest = { number: 92, url: 'https://github.com/marioparaschiv/unbound/pull/92', state: 'OPEN', author: { login: 'marioparaschiv' } };
	h.ghFails = /\/reviews/;

	await dispatcher.tick();
	assert.ok(h.logs.includes('poll failed: gh: HTTP 502'));
	assert.equal(claimsOnDisk(h)[0].status, 'running');

	h.ghFails = undefined;
	const restarted = await h.dispatcher();
	await restarted.tick();

	assert.deepEqual(
		ghWrites(h).map(({ args }) => args[3]),
		['repos/marioparaschiv/unbound/issues/92/comments', 'repos/marioparaschiv/unbound/pulls/92/reviews', 'repos/marioparaschiv/unbound/pulls/92/reviews'],
	);
	assert.equal(claimsOnDisk(h)[0].status, 'ended');

	const other = h.linear.addEpic({ identifier: 'UNB-57', title: 'No flags' });
	h.gh.length = 0;
	await restarted.tick();
	await restarted.handle({ type: 'started', epicId: other.id, run: runFor('UNB-57') });
	await restarted.handle({ type: 'status', epicId: other.id, status: 'idle', tail: 'Done.' });
	await restarted.handle({ type: 'result', epicId: other.id, result: result() });
	await restarted.tick();

	assert.deepEqual(
		ghWrites(h).map(({ args }) => args[3]),
		['repos/marioparaschiv/unbound/issues/92/comments'],
	);
});

test('an invalid result file is an error with the validation message on the epic', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-58', title: 'Bad result' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-58') });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'idle', tail: 'Wrote the result.' });

	await dispatcher.handle({ type: 'invalidResult', epicId: epic.id, error: '✖ Invalid input: expected array, received undefined\n  → at flags' });

	assert.equal(claimsOnDisk(h)[0].status, 'error');
	assert.match(h.linear.comments[0].body, /\(`error`\): the agent's result file is invalid:\n\n```\n✖ Invalid input: expected array, received undefined\n  → at flags\n```/);
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.deepEqual(ghWrites(h), []);
});

async function startedRun(h: Awaited<ReturnType<typeof harness>>, identifier: string, title: string) {
	const epic = h.linear.addEpic({ identifier, title, sortOrder: 1 });
	h.linear.addEpic({ identifier: `${identifier}9`, title: 'Queued behind it', sortOrder: 2 });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor(identifier) });

	return { epic, dispatcher, job: h.sent[0].job, run: runFor(identifier) };
}

const nudges = (h: { sent: DispatcherMessage[] }) => h.sent.filter((message) => message.type === 'nudge');

test('nudges a working agent once when its pane stops changing, and a change after the nudge clears it', async (t) => {
	const h = await harness(t);
	const { epic, dispatcher, job, run } = await startedRun(h, 'UNB-150', 'Long build');
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '✻ Compiling… (0m 1s)' });

	h.now += 599_000;
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '✶ Compiling… (9m 59s)' });
	await dispatcher.tick();
	assert.deepEqual(nudges(h), [], 'still inside the stale window');

	h.now += 1_000;
	await dispatcher.tick();
	h.now += 300_000;
	await dispatcher.tick();
	assert.deepEqual(nudges(h), [{ type: 'nudge', job, run }]);

	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '✻ Compiling…\nInterrupted\n> continue' });
	h.now += 599_000;
	await dispatcher.tick();

	assert.equal(nudges(h).length, 1);
	assert.equal(h.linear.comments.length, 0);
	assert.deepEqual(
		claimsOnDisk(h).map((claim) => [claim.status, 'nudgedAt' in claim]),
		[['running', false]],
	);
});

test('flags a run still unchanged after the nudge grace as stale, across a restart, until the pane moves', async (t) => {
	const h = await harness(t);
	const { epic, dispatcher } = await startedRun(h, 'UNB-151', 'Frozen');
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '✻ Thinking… (esc to interrupt)' });
	h.now += 600_000;
	await dispatcher.tick();

	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.handle({ type: 'status', epicId: epic.id, status: 'working', tail: '✻ Thinking… (esc to interrupt)' });
	h.now += 599_000;
	await restarted.tick();
	assert.equal(h.linear.comments.length, 0, 'still inside the nudge grace');

	h.now += 1_000;
	await restarted.tick();
	await restarted.tick();

	assert.equal(nudges(h).length, 1, 'a restart does not nudge again');
	assert.equal(h.linear.comments.length, 1);
	assert.match(h.linear.comments[0].body, /\(`stale`\): the agent has shown no new output for 20 min, even after a nudge/);
	assert.match(h.linear.comments[0].body, /✻ Thinking… \(esc to interrupt\)/);
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.equal(claimsOnDisk(h)[0].status, 'stale');
	assert.equal(h.sent.filter((message) => message.type === 'dispatch').length, 1, 'a stale run keeps its slot');

	await restarted.handle({ type: 'status', epicId: epic.id, status: 'working', tail: 'Running tests' });
	assert.equal(claimsOnDisk(h)[0].status, 'running');
});

test('flags a run past the wall-clock cap once, whatever its state, across restarts', async (t) => {
	const h = await harness(t);
	const { epic, dispatcher } = await startedRun(h, 'UNB-152', 'Endless');
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'idle', tail: 'Which database?' });
	h.now += 180_000;
	await dispatcher.tick();
	assert.equal(claimsOnDisk(h)[0].status, 'awaitingInput');

	h.now = claimsOnDisk(h)[0].claimedAt + 5_399_000;
	await dispatcher.tick();
	assert.equal(h.linear.comments.length, 1, 'still under the cap');

	h.now += 1_000;
	await dispatcher.tick();
	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.tick();

	assert.equal(h.linear.comments.length, 2);
	assert.match(h.linear.comments[1].body, /\(`awaitingInput`\): the run has been going for 90 min, over the 90 min cap/);
	assert.match(h.linear.comments[1].body, /Which database\?/);
	assert.equal(claimsOnDisk(h)[0].status, 'awaitingInput');
});

test('asks the question on the epic once and types the user\'s reply into the pane exactly once', async (t) => {
	const h = await harness(t);
	const { epic, dispatcher, job, run } = await startedRun(h, 'UNB-153', 'Needs a decision');
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'blocked', tail: 'Use Postgres or SQLite?' });
	h.now += 180_000;
	await dispatcher.tick();

	const [question] = h.linear.comments;
	assert.match(question.body, /Use Postgres or SQLite\?/);
	const unrelated = h.linear.addComment(epic.id, 'An older note');
	h.linear.addComment(epic.id, 'Not an answer', unrelated.id);
	h.linear.addComment(epic.id, '**herdr-linear:** a note from the dispatcher', question.id);
	const answer = h.linear.addComment(epic.id, 'SQLite.\nKeep it in one file.', question.id);

	await dispatcher.tick();
	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.tick();

	assert.deepEqual(
		h.sent.filter((message) => message.type === 'reply'),
		[{ type: 'reply', job, run, commentId: answer.id, text: 'SQLite.\nKeep it in one file.' }],
	);
	assert.deepEqual(answer.reactions, ['white_check_mark']);
	assert.equal(h.linear.comments.filter((comment) => comment.body.includes('Use Postgres or SQLite?')).length, 1, 'the question is asked once');

	await restarted.handle({ type: 'replyFailed', epicId: epic.id, commentId: answer.id, error: 'herdr agent_blocked: agent is blocked' });
	assert.equal(h.linear.comments.at(-1)?.parentId, answer.id);
	assert.match(h.linear.comments.at(-1)!.body, /couldn't type this reply into the agent's pane: herdr agent_blocked/);

	await restarted.handle({ type: 'status', epicId: epic.id, status: 'working', tail: 'Using SQLite' });
	assert.equal(claimsOnDisk(h)[0].status, 'running');
	assert.ok(!('questionCommentId' in claimsOnDisk(h)[0]));
});

test('flags a run that vanished without a PR as an error straight away and frees its slot', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-60', title: 'Tab closed', sortOrder: 1 });
	const next = h.linear.addEpic({ identifier: 'UNB-61', title: 'Next in line', sortOrder: 2 });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-60') });
	await dispatcher.handle({ type: 'finished', epicId: epic.id, reason: 'vanished', tail: '' });

	await dispatcher.tick();

	assert.equal(h.linear.comments.length, 1);
	assert.match(h.linear.comments[0].body, /\(`error`\): the agent disappeared \(its tab was closed or herdr restarted\)/);
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.equal(claimsOnDisk(h)[0].status, 'error');
	assert.deepEqual(
		h.sent.map((message) => message.job.epicId),
		[epic.id, next.id],
	);

	await dispatcher.tick();
	assert.equal(h.linear.comments.length, 1, 'an error is reported once');
});

test('an agent that exits after being flagged as awaiting input becomes an error', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-62', title: 'Gave up' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-62') });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'blocked', tail: 'Allow this command?' });
	h.now += 180_000;
	await dispatcher.tick();
	await dispatcher.handle({ type: 'finished', epicId: epic.id, reason: 'exited', tail: '$' });

	await dispatcher.tick();

	assert.equal(claimsOnDisk(h)[0].status, 'error');
	assert.deepEqual(
		h.linear.comments.map((comment) => /\(`(\w+)`\): the agent (\w+)/.exec(comment.body)?.slice(1).join(' ')),
		['awaitingInput has', 'error exited'],
	);
});

test('a run not confirmed within the start timeout is an error and frees its slot', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-65', title: 'Hung start', sortOrder: 1 });
	const next = h.linear.addEpic({ identifier: 'UNB-66', title: 'Next in line', sortOrder: 2 });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();

	h.now += 299_000;
	await dispatcher.tick();
	assert.equal(h.sent.length, 1, 'still inside the start timeout');

	h.now += 1_000;
	await dispatcher.tick();

	assert.equal(claimsOnDisk(h).find((claim) => claim.epicId === epic.id)?.status, 'error');
	assert.match(h.linear.comments[0].body, /\(`error`\): couldn't start an agent for this epic: the agent was not confirmed running within 300 s/);
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.deepEqual(
		h.sent.map((message) => message.job.epicId),
		[epic.id, next.id],
	);

	await dispatcher.handle({ type: 'failed', epicId: epic.id, error: 'herdr timeout' });
	assert.equal(h.linear.comments.length, 1, 'a late failure is not reported again');
});

test('a restarted dispatcher gives an unconfirmed run a fresh start timeout to be adopted', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-67', title: 'Claimed before a long outage' });
	await (await h.dispatcher()).tick();

	h.now += 3_600_000;
	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.tick();

	assert.equal(h.linear.comments.length, 0);
	await restarted.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-67') });
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
});

test('awaitingInput and stale claims hold a maxInFlight slot, error and ended ones do not', async (t) => {
	const h = await harness(t);
	const flagged = h.linear.addEpic({ identifier: 'UNB-1', title: 'Already running', stateId: 'st-impl' });
	h.linear.addEpic({ identifier: 'UNB-68', title: 'Waiting for a slot' });
	const job = {
		epicId: flagged.id,
		identifier: 'UNB-1',
		branch: runFor('UNB-1').branch,
		repoPath: '/srv/unbound',
		tabLabel: 'UNB-1 Already running',
		prompt: '/orchestrate',
	};

	for (const [status, holdsSlot] of [
		['awaitingInput', true],
		['stale', true],
		['error', false],
		['ended', false],
	] as const) {
		const claim = { epicId: flagged.id, identifier: 'UNB-1', teamId: UNBOUND_TEAM_ID, status, claimedAt: h.now, job, run: runFor('UNB-1') };
		writeFileSync(h.statePath, JSON.stringify({ claims: [claim] }));
		h.sent.length = 0;

		await (await h.dispatcher()).tick();

		assert.deepEqual(
			h.sent.map((message) => `${message.type} ${message.job.identifier}`),
			holdsSlot ? [] : ['dispatch UNB-68'],
			status,
		);
	}
});

async function endedRun(h: Awaited<ReturnType<typeof harness>>, identifier: string) {
	const epic = h.linear.addEpic({ identifier, title: 'Ready to ship' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor(identifier) });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'done', tail: 'Opened the PR.' });
	await dispatcher.handle({ type: 'result', epicId: epic.id, result: result() });
	h.pullRequest = { number: 120, url: 'https://github.com/marioparaschiv/unbound/pull/120', state: 'OPEN', author: { login: 'marioparaschiv' } };
	await dispatcher.tick();
	assert.equal(h.linear.stateName(epic.id), 'To Review');

	return { epic, job: h.sent[0].job, run: runFor(identifier) };
}

test('cleans up the worktree once the epic ships, across a restart, keeping a dirty one and saying so once', async (t) => {
	const h = await harness(t);
	const { epic, job, run } = await endedRun(h, 'UNB-120');
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();
	assert.deepEqual(
		h.sent.map((message) => message.type),
		['dispatch', 'close'],
		'nothing to clean while the PR is in review',
	);

	h.linear.issues.get(epic.id)!.stateId = 'st-shipped';
	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.tick();

	assert.deepEqual(h.sent.slice(2), [{ type: 'cleanup', job, run }], 'an ended run is not watched again');

	const kept = { type: 'kept', epicId: epic.id, worktreePath: run.worktreePath, reason: '2 unpushed commits' } as const;
	await restarted.handle(kept);
	await restarted.tick();
	await restarted.handle(kept);

	assert.equal(h.linear.comments.length, 1);
	assert.match(h.linear.comments[0].body, /kept the worktree `\/home\/dev\/\.herdr\/worktrees\/unbound\/mario-unb-120` because it has 2 unpushed commits/);
	assert.deepEqual(h.sent.at(-1), { type: 'cleanup', job, run }, 'a kept worktree is retried every poll');

	await restarted.handle({ type: 'cleaned', epicId: epic.id });
	assert.deepEqual(claimsOnDisk(h), []);

	const sent = h.sent.length;
	await restarted.tick();
	assert.equal(h.sent.length, sent);
	assert.ok(!h.logs.some((line) => /failed/.test(line)), h.logs.join('\n'));
});

test('a merged or closed PR triggers cleanup too', async (t) => {
	for (const state of ['MERGED', 'CLOSED'] as const) {
		const h = await harness(t);
		const { job, run } = await endedRun(h, 'UNB-121');
		h.pullRequest = { number: 121, url: 'https://github.com/marioparaschiv/unbound/pull/121', state, author: { login: 'marioparaschiv' } };

		await (await h.dispatcher()).tick();

		assert.deepEqual(h.sent.at(-1), { type: 'cleanup', job, run }, state);
	}
});

const asClaude = (body: string) => `${body}\n\n${ON_BEHALF_OF_CLAUDE}`;

const graphqlWrites = (h: { gh: { args: string[]; input?: string }[] }) =>
	ghWrites(h)
		.filter(({ args }) => args[1] === 'graphql')
		.map(({ body }) => [/^mutation (\w+)/.exec(body.query)?.[1], body.variables]);

test('/agent threads start one follow-up run, which replies to and resolves each of them as Claude', async (t) => {
	const h = await harness(t);
	const { epic, job: firstJob, run } = await endedRun(h, 'UNB-130');
	h.threads = [
		{ id: 'PRRT_inline', isResolved: false, comments: [{ body: 'Rename this to syncSettings. /agent' }] },
		{ id: 'PRRT_flag', isResolved: false, comments: [{ body: asClaude('This retry loop has no backoff. /agent can fix it.') }] },
		{
			id: 'PRRT_accepted_flag',
			isResolved: false,
			comments: [{ body: asClaude('The settings type duplicates the schema.') }, { body: '/agent yes, derive it' }],
		},
		{ id: 'PRRT_dismissed_flag', isResolved: true, comments: [{ body: asClaude('Unused import.') }, { body: '/agent' }] },
		{ id: 'PRRT_note', isResolved: false, comments: [{ body: '/agent rename it' }, { body: 'Actually, I will do it myself.' }] },
	];
	h.gh.length = 0;

	const dispatcher = await h.dispatcher();
	await dispatcher.tick();

	const followUps = h.sent.filter((message) => message.type === 'dispatch').slice(1);
	assert.equal(followUps.length, 1);
	const [{ job }] = followUps;
	assert.equal(
		job.prompt,
		`/follow-up Linear epic UNB-130 (https://linear.app/marioparaschiv/issue/UNB-130/ready-to-ship), PR https://github.com/marioparaschiv/unbound/pull/120, threads PRRT_inline PRRT_accepted_flag, autonomously, in the worktree you are in.`,
	);
	assert.deepEqual(job, { ...firstJob, prompt: job.prompt, threadIds: ['PRRT_inline', 'PRRT_accepted_flag'] });
	assert.equal(claimsOnDisk(h)[0].status, 'claimed');
	assert.deepEqual(ghWrites(h), [], 'scanning only reads');

	const restarted = await h.dispatcher();
	restarted.start();
	await restarted.tick();

	assert.deepEqual(h.sent.at(-1), { type: 'watch', job, run: undefined }, 'a restart re-attaches the follow-up');
	assert.equal(h.sent.filter((message) => message.type === 'dispatch').length, 2, 'a restart does not dispatch it again');

	await restarted.handle({ type: 'started', epicId: epic.id, run });
	assert.equal(h.linear.stateName(epic.id), 'Implementing');

	await restarted.handle({ type: 'status', epicId: epic.id, status: 'done', tail: 'Pushed the fixes.' });
	await restarted.handle({
		type: 'result',
		epicId: epic.id,
		result: result({
			summary: 'Renamed the sync function and derived the settings type.',
			replies: [
				{ threadId: 'PRRT_inline', body: 'Renamed it to syncSettings.' },
				{ threadId: 'PRRT_accepted_flag', body: 'The type is now inferred from the schema.' },
			],
		}),
	});
	await restarted.tick();

	assert.deepEqual(ghWrites(h)[0], {
		args: ['api', '--method', 'POST', 'repos/marioparaschiv/unbound/issues/120/comments', '--input', '-'],
		body: { body: asClaude('Renamed the sync function and derived the settings type.\n\nReady for review, @marioparaschiv.') },
	});
	assert.deepEqual(graphqlWrites(h), [
		['ReplyToThread', { threadId: 'PRRT_inline', body: asClaude('Renamed it to syncSettings.') }],
		['ResolveThread', { threadId: 'PRRT_inline' }],
		['ReplyToThread', { threadId: 'PRRT_accepted_flag', body: asClaude('The type is now inferred from the schema.') }],
		['ResolveThread', { threadId: 'PRRT_accepted_flag' }],
	]);
	assert.equal(ghWrites(h).length, 5);
	assert.equal(h.linear.stateName(epic.id), 'To Review');
	assert.equal(claimsOnDisk(h)[0].status, 'ended');

	await restarted.tick();
	assert.equal(h.sent.filter((message) => message.type === 'dispatch').length, 2, 'answered threads are not pending any more');
	assert.equal(ghWrites(h).length, 5);
});

test('a review with /agent in its body is one follow-up for all its threads, waiting for a free slot', async (t) => {
	const h = await harness(t);
	const { epic } = await endedRun(h, 'UNB-131');
	const busy = h.linear.addEpic({ identifier: 'UNB-132', title: 'Busy' });
	await (await h.dispatcher()).tick();
	h.linear.addEpic({ identifier: 'UNB-133', title: 'Queued' });
	h.threads = [1, 2, 3, 4, 5].map((index) => ({
		id: `PRRT_${index}`,
		isResolved: false,
		comments: [{ body: `Comment ${index}`, reviewBody: 'A few things to fix. /agent' }],
	}));
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();
	assert.deepEqual(
		h.sent.filter((message) => message.type === 'dispatch').map((message) => message.job.epicId),
		[epic.id, busy.id],
		'maxInFlight is used up by the busy epic',
	);

	await dispatcher.handle({ type: 'failed', epicId: busy.id, error: 'herdr timeout' });
	await dispatcher.tick();

	const dispatches = h.sent.filter((message) => message.type === 'dispatch');
	assert.equal(dispatches.length, 3, 'the follow-up goes before the queued epic');
	assert.deepEqual(dispatches[2].job.threadIds, ['PRRT_1', 'PRRT_2', 'PRRT_3', 'PRRT_4', 'PRRT_5']);
});

test('a restart while replying never replies twice', async (t) => {
	const h = await harness(t);
	const { epic, run } = await endedRun(h, 'UNB-134');
	h.threads = ['PRRT_a', 'PRRT_b'].map((id) => ({ id, isResolved: false, comments: [{ body: '/agent fix this' }] }));
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'idle', tail: 'Done.' });
	await dispatcher.handle({
		type: 'result',
		epicId: epic.id,
		result: result({ replies: [{ threadId: 'PRRT_a', body: 'Fixed.' }, { threadId: 'PRRT_b', body: 'Fixed too.' }] }),
	});
	h.gh.length = 0;
	h.ghFails = /ResolveThread.*PRRT_b/;

	await dispatcher.tick();
	assert.ok(h.logs.includes('poll failed: gh: HTTP 502'));

	h.ghFails = undefined;
	await (await h.dispatcher()).tick();

	assert.deepEqual(
		graphqlWrites(h).map(([operation, variables]) => `${operation} ${variables.threadId}`),
		['ReplyToThread PRRT_a', 'ResolveThread PRRT_a', 'ReplyToThread PRRT_b', 'ResolveThread PRRT_b', 'ResolveThread PRRT_b'],
	);
	assert.equal(ghWrites(h).filter(({ args }) => args[1] !== 'graphql').length, 1, 'one summary');
	assert.equal(h.linear.stateName(epic.id), 'To Review');
});

test('replies that do not match the dispatched threads are an error and nothing is posted', async (t) => {
	const h = await harness(t);
	const { epic, run } = await endedRun(h, 'UNB-135');
	h.threads = ['PRRT_a', 'PRRT_b'].map((id) => ({ id, isResolved: false, comments: [{ body: '/agent' }] }));
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run });
	await dispatcher.handle({ type: 'status', epicId: epic.id, status: 'idle', tail: 'Done.' });
	await dispatcher.handle({
		type: 'result',
		epicId: epic.id,
		result: result({ replies: [{ threadId: 'PRRT_a', body: 'Fixed.' }, { threadId: 'PRRT_z', body: 'Fixed.' }] }),
	});
	h.gh.length = 0;

	await dispatcher.tick();

	assert.deepEqual(ghWrites(h), []);
	assert.equal(claimsOnDisk(h)[0].status, 'error');
	assert.match(
		h.linear.comments.at(-1)!.body,
		/does not match the review threads it was given: no reply for PRRT_b; replies to threads it was not given PRRT_z\. Nothing was posted to the PR\. Remove the label and move the epic to To Review/,
	);
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
});

test('a follow-up that fails to start goes back to ended and is retried once the label is removed', async (t) => {
	const h = await harness(t);
	const { epic, run } = await endedRun(h, 'UNB-136');
	h.threads = [{ id: 'PRRT_a', isResolved: false, comments: [{ body: '/agent' }] }];
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();

	await dispatcher.handle({ type: 'failed', epicId: epic.id, error: 'git pull --ff-only failed' });
	await dispatcher.tick();

	assert.equal(claimsOnDisk(h)[0].status, 'ended');
	assert.deepEqual(JSON.parse(readFileSync(h.statePath, 'utf8')).claims[0].run, run, 'cleanup still knows the worktree');
	assert.match(h.linear.comments.at(-1)!.body, /couldn't start an agent for this epic: git pull --ff-only failed/);
	assert.equal(h.sent.filter((message) => message.type === 'dispatch').length, 2, 'not retried while labelled');

	h.linear.issues.get(epic.id)!.labelIds = [];
	await dispatcher.tick();
	assert.equal(h.sent.filter((message) => message.type === 'dispatch').length, 3);
});

test('a failed start is reported on the epic and retried only once the label is removed', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-70', title: 'Broken repo' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();

	await dispatcher.handle({
		type: 'failed',
		epicId: epic.id,
		error: 'Claude did not start in w1:t5: claude is blocked',
		tail: 'Do you trust the files in this folder?',
	});

	assert.equal(h.linear.stateName(epic.id), 'Ready For Agent');
	assert.match(h.linear.comments[0].body, /couldn't start an agent for this epic: Claude did not start/);
	assert.match(h.linear.comments[0].body, /Do you trust the files in this folder\?/);
	assert.deepEqual(h.linear.mutations, [`comment ${epic.id}`, 'create-label agent-stuck', `add-label ${epic.id} lbl-1`]);

	await dispatcher.tick();
	assert.equal(h.sent.length, 1, 'not retried while labelled');

	h.linear.issues.get(epic.id)!.labelIds = [];
	await dispatcher.tick();
	assert.equal(h.sent.length, 2);
	assert.equal(h.sent[1].type, 'dispatch');
});

test('an unresolvable repo label fails the epic without dispatching it', async (t) => {
	const h = await harness(t);
	h.linear.labels.push({ id: 'lbl-web', name: 'repo:web', teamId: null, parentName: null });
	const epic = h.linear.addEpic({ identifier: 'UNB-80', title: 'Two repos', labelIds: ['lbl-loader', 'lbl-web'] });
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();

	assert.deepEqual(h.sent, []);
	assert.match(h.linear.comments[0].body, /more than one repo label: loader-ios, web/);
	assert.deepEqual(h.linear.labelNames(epic.id), ['loader-ios', 'repo:web', 'agent-stuck']);
});

test('skips a team that lacks one of the workflow states, naming it', async (t) => {
	const h = await harness(t);
	h.linear.teams[0].states = unboundStates.filter((state) => state.name !== 'To Review');
	h.linear.addEpic({ identifier: 'UNB-90', title: 'Never picked up' });
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();
	await dispatcher.tick();

	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.logs, ['team Unbound has no workflow state "To Review"; skipping it until it does']);
});

test('does not pick up issues without sub-issues, or anything while paused', async (t) => {
	const h = await harness(t);
	h.linear.addEpic({ identifier: 'UNB-100', title: 'A lone issue' }, 0);
	h.paused = true;
	h.linear.addEpic({ identifier: 'UNB-101', title: 'A real epic' });
	const dispatcher = await h.dispatcher();

	await dispatcher.tick();
	assert.equal(h.sent.length, 0);

	h.paused = false;
	await dispatcher.tick();

	assert.deepEqual(
		h.sent.map((message) => message.job.identifier),
		['UNB-101'],
	);
	assert.ok(h.logs.includes('UNB-100 is in Ready For Agent but has no sub-issues; ignoring it'));
});
