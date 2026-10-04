import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ClaimStore } from './claims.ts';
import { configSchema } from './config.ts';
import { Dispatcher } from './dispatcher.ts';
import { FakeLinear, unboundStates } from './fixtures/linear-server.ts';
import type { PullRequest } from './github.ts';
import { LinearClient } from './linear.ts';
import type { DispatcherMessage, Run } from './protocol.ts';

const config = configSchema.parse({
	stuckAfterSeconds: 180,
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
				findPullRequest: async () => harness.pullRequest,
				isPaused: async () => harness.paused,
				now: () => harness.now,
				log: (line) => harness.logs.push(line),
			});
		},
	};

	return harness;
}

const runFor = (identifier: string): Run => ({
	tabId: 'w1:t4',
	paneId: 'w1:p7',
	worktreePath: `/home/dev/.herdr/worktrees/unbound/mario-${identifier.toLowerCase()}`,
	branch: `mario/${identifier.toLowerCase()}`,
	githubRepo: 'marioparaschiv/unbound',
});

const stateId = (name: string) => unboundStates.find((state) => state.name === name)!.id;

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
	assert.match(message.job.prompt, /^\/orchestrate the sub-issues of Linear epic UNB-12 \(https:\/\/linear\.app\/.+\)/);
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
	h.pullRequest = { url: 'https://github.com/marioparaschiv/unbound/pull/88', state: 'OPEN' };
	await dispatcher.tick();

	assert.equal(h.linear.stateName(first.id), 'To Review');
	assert.deepEqual(
		h.sent.map((message) => message.job.epicId),
		[first.id, second.id],
	);
});

test('flags an agent that sits idle without a PR, then hands the epic over once the PR exists', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-50', title: 'Stuck agent' });
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
	assert.equal(h.linear.comments.length, 0, 'still inside the grace period');

	h.now += 1_000;
	await dispatcher.tick();

	assert.equal(h.linear.comments.length, 1);
	const [comment] = h.linear.comments;
	assert.equal(comment.issueId, epic.id);
	assert.match(comment.body, /has been idle for 3 min without opening a PR/);
	assert.match(comment.body, /w1:t4/);
	assert.match(comment.body, /Which auth provider should slice 2 use\?/);
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);

	h.now += 600_000;
	await dispatcher.tick();
	assert.equal(h.linear.comments.length, 1, 'a stuck epic is reported once');
	assert.equal(h.sent.length, 1, 'a stuck epic still counts as in flight');

	h.pullRequest = { url: 'https://github.com/marioparaschiv/unbound/pull/91', state: 'OPEN' };
	await dispatcher.tick();

	assert.equal(h.linear.stateName(epic.id), 'To Review');
	assert.deepEqual(h.linear.labelNames(epic.id), []);
	assert.deepEqual(JSON.parse(readFileSync(h.statePath, 'utf8')).claims, []);
});

test('flags a run that vanished without a PR straight away', async (t) => {
	const h = await harness(t);
	const epic = h.linear.addEpic({ identifier: 'UNB-60', title: 'Tab closed' });
	const dispatcher = await h.dispatcher();
	await dispatcher.tick();
	await dispatcher.handle({ type: 'started', epicId: epic.id, run: runFor('UNB-60') });
	await dispatcher.handle({ type: 'finished', epicId: epic.id, reason: 'vanished', tail: '' });

	await dispatcher.tick();

	assert.equal(h.linear.comments.length, 1);
	assert.match(h.linear.comments[0].body, /disappeared \(its tab was closed or herdr restarted\)/);
	assert.equal(h.linear.stateName(epic.id), 'Implementing');
	assert.deepEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
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
