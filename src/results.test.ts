import { existsSync } from 'node:fs';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { Transient } from './call-policy.ts';
import type { Epic } from './linear.ts';
import type { StartedRun } from './observation.ts';
import { type Harness, makeHarness } from './test-harness.ts';

const resultFile = {
	summary: 'Plugin settings now sync across devices; conflicts keep the newest change.',
	replies: [],
	flags: [{ path: 'src/sync/merge.ts', line: 12, body: 'A tie keeps the local value; confirm that is wanted.' }],
};

// A run whose agent finished its turn after writing a valid result file, with the PR the agent opened.
const finishedRun = (h: Harness, result: object = resultFile) =>
	Effect.gen(function* () {
		const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });
		const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName, author: 'marioparaschiv' });

		h.writeResultFile(run, JSON.stringify(result));

		return { epic, run, pullRequest };
	});

// Where a finished run ends, compared as one value so a failure shows everything.
const outcome = (h: Harness, epic: Epic, run: StartedRun, number: number) =>
	Effect.gen(function* () {
		const [stored] = yield* h.runs;

		return {
			epicComments: h.epicMarkers(epic.id),
			pullRequestComments: h.github.comments(h.githubRepo, number),
			notices: h.notices(epic.identifier).map(({ marker }) => marker),
			state: h.linear.stateName(epic.id),
			tabOpen: Option.isSome(h.herdr.tab(run.tabId)),
			run: stored ? [stored.status, stored.result?.summary] : null,
			worktree: existsSync(run.worktreePath),
		};
	});

const finished = {
	epicComments: ['pullRequestOpened:https://github.com/test/repo/pull/1'],
	pullRequestComments: [],
	notices: ['summary:0', 'flags:0'],
	state: 'To Review',
	tabOpen: false,
	run: ['ended', resultFile.summary],
	worktree: true,
};

describe('results', () => {
	it.effect('links the PR on the epic, sums up the run and its flags in notices, moves the epic to To Review and closes the tab, leaving the worktree', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run, pullRequest } = yield* finishedRun(h);

			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, run, pullRequest.number), finished);

			assert.deepStrictEqual(
				h.notices(epic.identifier).map(({ text }) => text),
				[
					`✅ **TEST-10 is ready for review**: ${pullRequest.url}\n${resultFile.summary}\nNext: Review the PR.`,
					'🔎 **TEST-10 left 1 self-review finding unfixed**\n- `src/sync/merge.ts:12` A tie keeps the local value; confirm that is wanted.\nNext: Ask for a follow-up to fix any of them.',
				],
			);
			assert.match(h.linear.comments(epic.id)[0].body, new RegExp(`^PR opened: ${RegExp.escape(pullRequest.url)}\n\n<!-- `));
		}),
	);

	it.effect('writes no flags notice when there are no flags and takes the stuck label off', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run, pullRequest } = yield* finishedRun(h, { ...resultFile, flags: [] });
			const stuck = h.linear.addLabel({ name: 'agent-stuck' });

			h.linear.issue(epic.id).labelIds = [stuck.id];
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, run, pullRequest.number), { ...finished, notices: ['summary:0'] });
			assert.deepStrictEqual(h.linear.labelNames(epic.id), []);
		}),
	);

	it.effect('posts each part once when a crash follows the tab close or a journal write', () =>
		Effect.gen(function* () {
			const crash = new Transient({ message: 'the process died' });
			// herdr: the tab close. Journal: the stored result, the summary and flags notices, then the ended run.
			const injections: ReadonlyArray<[string, (h: Harness) => void]> = [
				['after closing the tab', (h) => h.herdr.crashAfterWrite(1, crash)],
				['before storing the result', (h) => h.crashAtJournalWrite(1)],
				['before writing the summary notice', (h) => h.crashAtJournalWrite(2)],
				['before writing the flags notice', (h) => h.crashAtJournalWrite(3)],
				['before ending the run', (h) => h.crashAtJournalWrite(4)],
			];

			for (const [where, inject] of injections) {
				const h = yield* makeHarness();
				const { epic, run, pullRequest } = yield* finishedRun(h);

				inject(h);
				yield* h.tick;
				assert.notDeepEqual(yield* outcome(h, epic, run, pullRequest.number), finished, `crash ${where} took effect`);

				yield* h.restart;
				yield* h.tick;
				yield* h.tick;

				assert.deepStrictEqual(yield* outcome(h, epic, run, pullRequest.number), finished, `crash ${where}`);
			}
		}),
	);

	it.effect('closes a tab the user renamed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run, pullRequest } = yield* finishedRun(h);

			yield* h.renameTab(run.tabId, 'sync work');
			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, run, pullRequest.number), finished);
			assert.deepStrictEqual(h.herdr.closedTabs(), [run.tabId]);
		}),
	);

	it.effect('ends the run once the epic is moved back to Ready For Agent and the agent is not working; removing the label starts over', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const stuck = h.linear.addLabel({ name: 'agent-stuck' });

			h.linear.issue(epic.id).labelIds = [stuck.id];
			h.moveEpic(epic.id, 'Ready For Agent');
			yield* h.tick;
			// Closing the tab now would kill the agent mid-turn.
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));

			h.herdr.setAgentStatus(run.paneId, 'idle');
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.closedTabs(), [run.tabId]);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['ended'],
			);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);

			h.linear.issue(epic.id).labelIds = [];
			yield* h.tick;

			const [restarted] = yield* h.runs;

			assert.deepStrictEqual([restarted.status, restarted.worktreePath], ['running', run.worktreePath]);
			assert.notStrictEqual(restarted.tabId, run.tabId);
			assert.strictEqual(h.herdr.starts().length, 1);
			assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');
		}),
	);

	it.effect('flags an invalid result file once and keeps the tab open', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'done' });

			h.writeResultFile(run, JSON.stringify({ summary: '', replies: [], flags: [] }));
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['invalidResult:0']);
			assert.match(h.notices(epic.identifier)[0].text, /^🔴 \*\*TEST-10 wrote an invalid result file\*\*/);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
			assert.deepStrictEqual(h.linear.labelNames(epic.id), ['agent-stuck']);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['error'],
			);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));
		}),
	);

	it.effect('flags a result without a PR once, then posts it when the PR shows up', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			h.writeResultFile(run, JSON.stringify(resultFile));
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['noPullRequest:0']);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['error'],
			);
			assert.isTrue(Option.isSome(h.herdr.tab(run.tabId)));

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, author: 'marioparaschiv' });

			yield* h.tick;

			assert.deepStrictEqual(yield* outcome(h, epic, run, pullRequest.number), { ...finished, notices: ['noPullRequest:0', 'summary:0', 'flags:0'] });
		}),
	);
});
