import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { Refused } from './ctl.ts';
import { ON_BEHALF_OF_CLAUDE } from './github.ts';
import type { Epic } from './linear.ts';
import { git, type Harness, makeHarness, markerKeys } from './test-harness.ts';

// An epic whose first run posted its result and went to To Review, with the branch on origin. A minute passes, so the
// follow-up's claim (at `followUpAt`) has markers of its own. `push: false` leaves the branch local only, so pulling it fails.
const reviewedEpic = (h: Harness, { push = true }: { readonly push?: boolean } = {}) =>
	Effect.gen(function* () {
		const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });
		const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName, author: 'marioparaschiv' });

		h.writeResultFile(run, JSON.stringify({ summary: 'Plugin settings now sync across devices.', replies: [], flags: [] }));
		yield* h.tick;
		assert.strictEqual(h.linear.stateName(epic.id), 'To Review');

		if (push) {
			git(run.worktreePath, 'push', '--quiet', 'origin', epic.branchName);
		}

		yield* TestClock.adjust('1 minute');

		return { epic, worktreePath: run.worktreePath, pullRequest, firstRunAt: run.claimedAt, followUpAt: yield* Clock.currentTimeMillis };
	});

// Two threads asking for changes, and one the reviewer keeps for themselves.
const addThreads = (h: Harness, number: number) => {
	const rename = h.github.addThread(h.githubRepo, number, { comments: [{ body: 'Rename this to syncSettings.' }] });
	const backoff = h.github.addThread(h.githubRepo, number, { comments: [{ body: 'This retry loop has no backoff.' }] });
	const note = h.github.addThread(h.githubRepo, number, { comments: [{ body: 'I will update the docs myself.' }] });

	return { rename, backoff, note };
};

// What a command's agent runs to hand the two threads to a follow-up.
const requestFollowUp = (h: Harness, { rename, backoff }: { readonly rename: string; readonly backoff: string }) =>
	h.ctl('follow-up', 'TEST-10', 'Keep', 'the', 'public', 'API.', '--threads', rename, '--threads', backoff);

const replies = (rename: string, backoff: string) => [
	{ threadId: rename, body: 'Renamed it to syncSettings.' },
	{ threadId: backoff, body: 'The retry loop now backs off exponentially.' },
];

// The follow-up's tab: the first run's tab is closed by then.
const followUpTab = (h: Harness, epic: Epic) => {
	const tab = h.herdr.tabs().find((candidate) => candidate.label.startsWith(`${epic.identifier} `));

	if (!tab) {
		throw new Error(`no tab for ${epic.identifier}`);
	}

	return tab;
};

// Where the threads and the epic end up, compared as one value so a failure shows everything.
const outcome = (h: Harness, epic: Epic, number: number, threadIds: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		return {
			threads: threadIds.map((threadId) => {
				const thread = h.github.thread(threadId);

				return [thread.isResolved, markerKeys(thread.comments.map((comment) => comment.body))];
			}),
			pullRequestComments: markerKeys(h.github.comments(h.githubRepo, number)),
			state: h.linear.stateName(epic.id),
			openTabs: h.herdr.tabs().filter((tab) => tab.label.startsWith(`${epic.identifier} `)).length,
			runs: (yield* h.runs).map((run) => `${run.status} ${run.job._tag}`),
			linearComments: h.epicMarkers(epic.id),
		};
	});

const answered = ({ rename, backoff, firstRunAt, followUpAt }: { readonly rename: string; readonly backoff: string; readonly firstRunAt: number; readonly followUpAt: number }) => ({
	threads: [
		[true, [`reply:${rename}.${followUpAt}`]],
		[true, [`reply:${backoff}.${followUpAt}`]],
	],
	pullRequestComments: [`summary:${firstRunAt}`, `summary:${followUpAt}`],
	state: 'To Review',
	openTabs: 0,
	runs: ['ended follow-up'],
	linearComments: [],
});

describe('follow-ups', () => {
	it.effect('a follow-up request starts one follow-up run for its threads and instruction, whose result replies to and resolves each as Claude and hands the epic back', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, worktreePath, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h);
			const { rename, backoff, note } = addThreads(h, pullRequest.number);
			const reviewer = join(h.dir, 'seed');

			// A suggestion the reviewer committed on GitHub, which the follow-up must build on.
			git(reviewer, 'fetch', '--quiet', h.origin, epic.branchName);
			git(reviewer, 'checkout', '--quiet', '-B', 'suggestion', 'FETCH_HEAD');
			git(reviewer, 'commit', '--quiet', '--allow-empty', '-m', 'Apply suggestion from review');
			git(reviewer, 'push', '--quiet', h.origin, `HEAD:${epic.branchName}`);

			assert.deepStrictEqual(yield* requestFollowUp(h, { rename, backoff }), [
				'TEST-10 gets a follow-up once its run ended, while it is in To Review without the stuck label and a slot is free',
			]);

			yield* h.pausedTick;
			assert.deepStrictEqual(h.herdr.starts(), []);

			yield* h.tick;
			yield* h.tick;

			const tab = followUpTab(h, epic);

			assert.deepStrictEqual(
				h.herdr.starts().map(({ paneId, prompt }) => [paneId, prompt]),
				[
					[
						tab.paneId,
						`/follow-up Linear epic TEST-10 (https://linear.app/marioparaschiv/issue/TEST-10/plugin-settings-sync), PR ${pullRequest.url}, threads ${rename} ${backoff}, instruction "Keep the public API.", autonomously, in the worktree you are in.`,
					],
				],
			);
			assert.strictEqual(git(worktreePath, 'log', '-1', '--format=%s'), 'Apply suggestion from review');
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job, run.worktreePath, run.claimedAt]),
				[['running', { _tag: 'follow-up', threadIds: [rename, backoff], instruction: 'Keep the public API.' }, worktreePath, followUpAt]],
			);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');

			h.herdr.setAgentStatus(tab.paneId, 'done');
			h.writeResultFile((yield* h.runs)[0], JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }));
			assert.strictEqual(h.herdr.closedTabs().at(-1), tab.tabId);
			assert.deepStrictEqual(
				h.github.thread(rename).comments.map((comment) => comment.body.split('\n\n')[0]),
				['Rename this to syncSettings.', 'Renamed it to syncSettings.'],
			);
			assert.isTrue(h.github.thread(backoff).comments[1].body.endsWith(ON_BEHALF_OF_CLAUDE));
			assert.deepStrictEqual([h.github.thread(note).isResolved, h.github.thread(note).comments.length], [false, 1]);
			assert.isTrue(h.github.comments(h.githubRepo, pullRequest.number)[1].startsWith('Renamed the sync function and added backoff.\n\nReady for review, @marioparaschiv.'));
			assert.strictEqual(h.herdr.starts().length, 1);
			assert.deepStrictEqual(yield* h.ctl('status'), [
				`TEST-10 ended (follow-up), epic in To Review, claimed 1970-01-01T00:01:00.000Z, tab ${tab.tabId}, ${worktreePath}`,
				'no commands',
			]);
		}),
	);

	it.effect('a request made while a follow-up runs starts another one once that ended, with only an instruction', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h);
			const { rename, backoff } = addThreads(h, pullRequest.number);

			yield* requestFollowUp(h, { rename, backoff });
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.ctl('follow-up', 'TEST-10', 'Also update the changelog.');
			yield* h.tick;
			assert.deepStrictEqual((yield* h.runs).map((run) => [run.status, run.claimedAt]), [['running', followUpAt]]);

			h.herdr.setAgentStatus(followUpTab(h, epic).paneId, 'done');
			h.writeResultFile((yield* h.runs)[0], JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const secondAt = yield* Clock.currentTimeMillis;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job, run.claimedAt]),
				[['running', { _tag: 'follow-up', threadIds: [], instruction: 'Also update the changelog.' }, secondAt]],
			);
			assert.deepStrictEqual(markerKeys(h.github.comments(h.githubRepo, pullRequest.number)), [`summary:${firstRunAt}`, `summary:${followUpAt}`]);
			assert.match(h.herdr.starts()[1].prompt, /, no threads, instruction "Also update the changelog\.", autonomously/);
		}),
	);

	it.effect('claims a follow-up exactly once when the process dies at any journal write of the claim and start', () =>
		Effect.gen(function* () {
			for (let nth = 1; nth <= 3; nth += 1) {
				const h = yield* makeHarness();
				const { pullRequest } = yield* reviewedEpic(h);
				const threads = addThreads(h, pullRequest.number);

				yield* requestFollowUp(h, threads);
				h.crashAtJournalWrite(nth);
				yield* h.tick;
				assert.isTrue(h.crashed(), `crash at journal write ${nth}`);
				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				assert.deepStrictEqual(
					(yield* h.runs).map((run) => `${run.status} ${run.job._tag}`),
					['running follow-up'],
					`crash at journal write ${nth}`,
				);
				assert.strictEqual(h.herdr.starts().length, 1, `crash at journal write ${nth}`);
				assert.deepStrictEqual(yield* h.ctl('status').pipe(Effect.map((lines) => lines.slice(1))), ['no commands'], `crash at journal write ${nth}`);
			}
		}),
	);

	it.effect('replies once to and resolves every thread when a crash follows any PR write, after a restart', () =>
		Effect.gen(function* () {
			const crash = new Transient({ message: 'the process died' });
			// GitHub writes: the summary, then a reply and a resolve per thread.
			const writes = ['the summary', 'the first reply', 'the first resolve', 'the second reply', 'the second resolve'];

			for (const [index, where] of writes.entries()) {
				const h = yield* makeHarness();
				const { epic, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h);
				const { rename, backoff } = addThreads(h, pullRequest.number);

				yield* requestFollowUp(h, { rename, backoff });
				yield* h.tick;
				h.herdr.setAgentStatus(followUpTab(h, epic).paneId, 'idle');
				h.writeResultFile((yield* h.runs)[0], JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
				h.github.crashAfterWrite(index + 1, crash);
				yield* h.tick;
				assert.notDeepEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }), `crash after ${where} took effect`);

				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				assert.deepStrictEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }), `crash after ${where}`);
				assert.strictEqual(h.herdr.starts().length, 1, `crash after ${where}`);
			}
		}),
	);

	it.effect('posts nothing to the PR and comments once when the replies do not match the threads', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h);
			const { rename, backoff } = addThreads(h, pullRequest.number);

			yield* requestFollowUp(h, { rename, backoff });
			yield* h.tick;

			const tab = followUpTab(h, epic);

			h.herdr.setAgentStatus(tab.paneId, 'idle');
			h.writeResultFile(
				(yield* h.runs)[0],
				JSON.stringify({ summary: 'Renamed the sync function.', replies: [{ threadId: rename, body: 'Renamed it.' }, { threadId: 'PRRT_99', body: 'Done.' }], flags: [] }),
			);
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), {
				threads: [
					[false, []],
					[false, []],
				],
				pullRequestComments: [`summary:${firstRunAt}`],
				state: 'Implementing',
				openTabs: 1,
				runs: ['error follow-up'],
				linearComments: [`threadMismatch:${followUpAt}`],
			});
			assert.match(
				h.linear.comments(epic.id)[0].body,
				new RegExp(`no reply for ${backoff}; replies to threads it was not given PRRT_99\\. Nothing was posted to the PR\\. Remove the label, move the epic to To Review and mention @orchestratorbot`),
			);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
		}),
	);

	it.effect('waits for a free slot and goes before a ready epic once one frees', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 1 });
			const { epic, pullRequest } = yield* reviewedEpic(h);
			const busy = yield* h.startedRun({ identifier: 'TEST-11', title: 'Busy', agentStatus: 'idle' });

			yield* requestFollowUp(h, addThreads(h, pullRequest.number));
			yield* h.tick;
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.identifier, run.status]),
				[
					['TEST-10', 'ended'],
					['TEST-11', 'running'],
				],
			);

			const queued = h.linear.addEpic({ identifier: 'TEST-12', title: 'Queued' });

			// Moving the busy epic away ends its run, which frees the slot.
			h.moveEpic(busy.epic.id, 'To Do');
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.identifier, run.status, run.job._tag]).toSorted(),
				[
					['TEST-10', 'running', 'follow-up'],
					['TEST-11', 'ended', 'orchestrate'],
				],
			);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
			assert.strictEqual(h.linear.stateName(queued.id), 'Ready For Agent');
		}),
	);

	it.effect('a follow-up that fails to start goes back to ended in To Review, keeps its worktree and is asked for again once the label is removed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, worktreePath, pullRequest, followUpAt } = yield* reviewedEpic(h, { push: false });
			const threads = addThreads(h, pullRequest.number);

			yield* requestFollowUp(h, threads);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job._tag, run.worktreePath]),
				[['ended', 'follow-up', worktreePath]],
			);
			assert.deepStrictEqual(h.worktrees(), [worktreePath]);
			assert.deepStrictEqual(h.epicMarkers(epic.id), [`startFailed:${followUpAt}`]);
			assert.match(h.linear.comments(epic.id)[0].body, /pull --ff-only/);
			assert.strictEqual(h.linear.stateName(epic.id), 'To Review');
			assert.deepStrictEqual(h.herdr.starts(), []);

			git(worktreePath, 'push', '--quiet', 'origin', epic.branchName);
			h.linear.issue(epic.id).labelIds = [];
			yield* h.tick;
			assert.deepStrictEqual(h.herdr.starts(), []);

			yield* requestFollowUp(h, threads);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job._tag]),
				[['running', 'follow-up']],
			);
			assert.strictEqual(h.herdr.starts().length, 1);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
		}),
	);

	it.effect('refuses a follow-up for an epic without a run, or without an instruction or a thread', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* reviewedEpic(h);

			assert.deepStrictEqual(yield* h.ctl('follow-up', 'TEST-99', 'Rename it.').pipe(Effect.flip), new Refused({ message: 'TEST-99 has no run to follow up on' }));
			assert.deepStrictEqual(yield* h.ctl('follow-up', 'test-10').pipe(Effect.flip), new Refused({ message: 'give an instruction, --threads, or both' }));
		}),
	);
});
