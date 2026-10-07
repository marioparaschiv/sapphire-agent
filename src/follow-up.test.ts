import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Clock, Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { Refused } from './ctl.ts';
import type { FixtureIssue } from './linear-fixture.ts';
import { git, type Harness, makeHarness, markerKeys } from './test-harness.ts';

// An epic whose first run posted its result and went to To Review, with the branch on origin. A minute passes, so the
// follow-up's claim (at `followUpAt`) has markers of its own. `push: false` leaves the branch local only, so pulling it fails.
const reviewedEpic = (h: Harness, { push = true }: { readonly push?: boolean } = {}) =>
	Effect.gen(function* () {
		const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
		const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });

		yield* h.t3.setRunStatus(run.threadId, 'completed');
		h.writeResultFile(run, JSON.stringify({ summary: 'Plugin settings now sync across devices.', replies: [], flags: [] }));
		yield* h.tick;
		assert.strictEqual(h.linear.stateName(epic.id), 'To Review');

		if (push) {
			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);
		}

		yield* TestClock.adjust('1 minute');

		return { epic, branch: run.branch, worktreePath: run.worktreePath, pullRequest, firstThreadId: run.threadId, firstRunAt: run.claimedAt, followUpAt: yield* Clock.currentTimeMillis };
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

// The threads launched after the first run's.
const followUpLaunches = (h: Harness) => h.t3.launches.pipe(Effect.map((launches) => launches.slice(1)));

// The follow-up's agent ends its turn; returns its run.
const finishTurn = (h: Harness) =>
	Effect.gen(function* () {
		const [run] = yield* h.runs;

		if (run.threadId === null) {
			return yield* Effect.die(new Error(`${run.identifier} has no thread`));
		}

		yield* h.t3.setRunStatus(run.threadId, 'completed');

		return run;
	});

// Where the threads and the epic end up, compared as one value so a failure shows everything.
const outcome = (h: Harness, epic: FixtureIssue, number: number, threadIds: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		return {
			threads: threadIds.map((threadId) => {
				const thread = h.github.thread(threadId);

				return [thread.isResolved, markerKeys(thread.comments.map((comment) => comment.body))];
			}),
			pullRequestComments: markerKeys(h.github.comments(h.githubRepo, number)),
			notices: h.notices(epic.identifier).map(({ marker }) => marker),
			state: h.linear.stateName(epic.id),
			runs: (yield* h.runs).map((run) => `${run.status} ${run.job._tag}`),
			linearComments: h.epicMarkers(epic.id),
		};
	});

const pullRequestOpened = 'pullRequestOpened:https://github.com/test/repo/pull/1';

const answered = ({ rename, backoff, firstRunAt, followUpAt }: { readonly rename: string; readonly backoff: string; readonly firstRunAt: number; readonly followUpAt: number }) => ({
	threads: [
		[true, [`reply:${rename}.${followUpAt}`]],
		[true, [`reply:${backoff}.${followUpAt}`]],
	],
	pullRequestComments: [`addressed:${followUpAt}`],
	notices: [`summary:${firstRunAt}`, `summary:${followUpAt}`],
	state: 'To Review',
	runs: ['ended follow-up'],
	linearComments: [pullRequestOpened, `summary:${firstRunAt}`, `summary:${followUpAt}`],
});

describe('follow-ups', () => {
	it.effect('a follow-up request starts one follow-up run for its threads and instruction, whose result replies to and resolves each as Claude and hands the epic back', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, branch, worktreePath, pullRequest, firstThreadId, firstRunAt, followUpAt } = yield* reviewedEpic(h);
			const { rename, backoff, note } = addThreads(h, pullRequest.number);
			const reviewer = join(h.dir, 'seed');

			// A suggestion the reviewer committed on GitHub, which the follow-up must build on.
			git(reviewer, 'fetch', '--quiet', h.origin, branch);
			git(reviewer, 'checkout', '--quiet', '-B', 'suggestion', 'FETCH_HEAD');
			git(reviewer, 'commit', '--quiet', '--allow-empty', '-m', 'Apply suggestion from review');
			git(reviewer, 'push', '--quiet', h.origin, `HEAD:${branch}`);

			assert.deepStrictEqual(yield* requestFollowUp(h, { rename, backoff }), [
				'TEST-10 gets a follow-up once its run ended, while it is in To Review without the stuck label and a slot is free',
			]);

			yield* h.pausedTick;
			assert.deepStrictEqual(yield* followUpLaunches(h), []);

			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* followUpLaunches(h)).map(({ message, workspaceStrategy }) => [message, workspaceStrategy]),
				[
					[
						`/follow-up Linear epic TEST-10, PR ${pullRequest.url}, threads ${rename} ${backoff}, instruction "Keep the public API."`,
						{ type: 'existing_worktree', worktreePath, branch },
					],
				],
			);
			assert.strictEqual(git(worktreePath, 'log', '-1', '--format=%s'), 'Apply suggestion from review');
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(firstThreadId), (thread) => thread.settled), Option.some(true));
			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job, run.worktreePath, run.claimedAt]),
				[['running', { _tag: 'follow-up', threadIds: [rename, backoff], instruction: 'Keep the public API.' }, worktreePath, followUpAt]],
			);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');

			const followUp = yield* finishTurn(h);

			h.writeResultFile(followUp, JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }));
			assert.deepStrictEqual(
				h.github.thread(rename).comments.map((comment) => comment.body.split('\n\n')[0]),
				['Rename this to syncSettings.', 'Renamed it to syncSettings.'],
			);
			assert.strictEqual(h.github.thread(backoff).comments[1].author, 'orchestratorbot[bot]');
			assert.deepStrictEqual([h.github.thread(note).isResolved, h.github.thread(note).comments.length], [false, 1]);
			assert.deepStrictEqual(
				h.github.botComments(h.githubRepo, pullRequest.number).map((body) => body.split('\n\n')[0]),
				['Addressed your concerns inline.'],
			);
			assert.isTrue(h.notices(epic.identifier)[1].text.startsWith(`✅ **TEST-10 is ready for review**: ${pullRequest.url}\nRenamed the sync function and added backoff.`));
			assert.lengthOf(yield* followUpLaunches(h), 1);
			assert.deepStrictEqual(yield* h.ctl('status'), [
				'dispatching: active',
				`project Test: ${h.repo}`,
				`TEST-10 ended (follow-up), epic in To Review, claimed 1970-01-01T00:01:00.000Z, T3 thread ${followUp.threadId}, session test-10, ${worktreePath}`,
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

			h.writeResultFile(yield* finishTurn(h), JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
			yield* h.tick;
			yield* TestClock.adjust('1 minute');
			yield* h.tick;

			const secondAt = yield* Clock.currentTimeMillis;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job, run.claimedAt]),
				[['running', { _tag: 'follow-up', threadIds: [], instruction: 'Also update the changelog.' }, secondAt]],
			);
			assert.deepStrictEqual(markerKeys(h.github.comments(h.githubRepo, pullRequest.number)), [`addressed:${followUpAt}`]);
			assert.deepStrictEqual(
				h.notices(epic.identifier).map(({ marker }) => marker),
				[`summary:${firstRunAt}`, `summary:${followUpAt}`],
			);
			assert.deepStrictEqual(
				(yield* followUpLaunches(h)).map(({ message }) => message),
				[
					`/follow-up Linear epic TEST-10, PR ${pullRequest.url}, threads ${rename} ${backoff}, instruction "Keep the public API."`,
					`/follow-up Linear epic TEST-10, PR ${pullRequest.url}, no threads, instruction "Also update the changelog."`,
				],
			);
		}),
	);

	it.effect('claims a follow-up exactly once when the process dies at any journal write of the claim and start', () =>
		Effect.gen(function* () {
			for (let nth = 1; nth <= 3; nth += 1) {
				const h = yield* makeHarness();
				const { pullRequest, worktreePath } = yield* reviewedEpic(h);
				const threads = addThreads(h, pullRequest.number);

				yield* requestFollowUp(h, threads);
				h.crashAtJournalWrite(nth);
				yield* h.tick;
				assert.isTrue(h.crashed(), `crash at journal write ${nth}`);
				yield* h.restart;
				yield* h.tick;
				assert.deepStrictEqual(
					(yield* h.runs).map((run) => run.worktreePath),
					[worktreePath],
					`crash at journal write ${nth}`,
				);
				yield* h.tick;

				assert.deepStrictEqual(
					(yield* h.runs).map((run) => `${run.status} ${run.job._tag}`),
					['running follow-up'],
					`crash at journal write ${nth}`,
				);
				assert.lengthOf(yield* followUpLaunches(h), 1, `crash at journal write ${nth}`);
				assert.deepStrictEqual(yield* h.ctl('status').pipe(Effect.map((lines) => lines.slice(3))), ['no commands'], `crash at journal write ${nth}`);
			}
		}),
	);

	it.effect('replies once to and resolves every thread when a crash follows any PR write, after a restart', () =>
		Effect.gen(function* () {
			const crash = new Transient({ message: 'the process died' });
			// GitHub writes: a reply and a resolve per thread, then the one PR comment.
			const writes = ['the first reply', 'the first resolve', 'the second reply', 'the second resolve', 'the PR comment'];

			for (const [index, where] of writes.entries()) {
				const h = yield* makeHarness();
				const { epic, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h);
				const { rename, backoff } = addThreads(h, pullRequest.number);

				yield* requestFollowUp(h, { rename, backoff });
				yield* h.tick;
				h.writeResultFile(yield* finishTurn(h), JSON.stringify({ summary: 'Renamed the sync function and added backoff.', replies: replies(rename, backoff), flags: [] }));
				h.github.crashAfterWrite(index + 1, crash);
				yield* h.tick;
				assert.notDeepEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }), `crash after ${where} took effect`);

				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				assert.deepStrictEqual(yield* outcome(h, epic, pullRequest.number, [rename, backoff]), answered({ rename, backoff, firstRunAt, followUpAt }), `crash after ${where}`);
				assert.lengthOf(yield* followUpLaunches(h), 1, `crash after ${where}`);
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
			h.writeResultFile(
				yield* finishTurn(h),
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
				pullRequestComments: [],
				notices: [`summary:${firstRunAt}`, `threadMismatch:${followUpAt}`],
				state: 'Implementing',
				runs: ['error follow-up'],
				linearComments: [pullRequestOpened, `summary:${firstRunAt}`, `threadMismatch:${followUpAt}`],
			});
			assert.match(
				h.notices(epic.identifier)[1].text,
				new RegExp(`no reply for ${backoff}; replies to threads it was not given PRRT_99\\. Nothing was posted to the PR\\.\nNext: Remove the \`agent-stuck\` label, move the epic to To Review and ask for the follow-up again\\.$`),
			);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
		}),
	);

	it.effect('waits for a free slot and goes before a ready epic once one frees', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness({ maxInFlight: 1 });
			const { epic, pullRequest } = yield* reviewedEpic(h);
			const busy = yield* h.threadRun({ identifier: 'TEST-11', title: 'Busy' });

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

			// Moving the busy epic away ends its run once its agent stopped, which frees the slot.
			yield* h.t3.setRunStatus(busy.run.threadId, 'completed');
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
			const { epic, branch, worktreePath, pullRequest, firstRunAt, followUpAt } = yield* reviewedEpic(h, { push: false });
			const threads = addThreads(h, pullRequest.number);

			yield* requestFollowUp(h, threads);
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job._tag, run.worktreePath]),
				[['ended', 'follow-up', worktreePath]],
			);
			assert.deepStrictEqual(h.worktrees(), [worktreePath]);
			assert.deepStrictEqual(
				h.notices(epic.identifier).map(({ marker }) => marker),
				[`summary:${firstRunAt}`, `startFailed:${followUpAt}`],
			);
			assert.match(h.notices(epic.identifier)[1].text, /pull --ff-only/);
			assert.strictEqual(h.linear.stateName(epic.id), 'To Review');
			assert.deepStrictEqual(yield* followUpLaunches(h), []);

			git(worktreePath, 'push', '--quiet', 'origin', branch);
			h.linear.issue(epic.id).labelIds = [];
			yield* h.tick;
			assert.deepStrictEqual(yield* followUpLaunches(h), []);

			yield* requestFollowUp(h, threads);
			yield* h.tick;

			assert.deepStrictEqual(
				(yield* h.runs).map((run) => [run.status, run.job._tag]),
				[['running', 'follow-up']],
			);
			assert.lengthOf(yield* followUpLaunches(h), 1);
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
