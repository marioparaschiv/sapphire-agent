import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { Transient } from './call-policy.ts';
import { git, type Harness, makeHarness } from './test-harness.ts';

const open = (h: Harness, tabId: string) => Option.isSome(h.herdr.tab(tabId));

// A worktree as sapphire-agent (or herdr) lays it out, on a new branch from origin/main, with no run tracking it.
const untrackedWorktree = (h: Harness, branch: string) => {
	const path = join(h.dir, 'worktrees', 'repo', branch.replace(/[^A-Za-z0-9._-]+/g, '-'));

	git(h.repo, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, 'origin/main');

	return path;
};

describe('cleanup', () => {
	it.effect('once the PR is merged, closes the tab, removes the worktree and local branch, and drops the run', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });
			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName });

			yield* h.tick;
			assert.isTrue(open(h, run.tabId));

			h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
			yield* h.tick;

			assert.isFalse(open(h, run.tabId));
			assert.deepStrictEqual(h.worktrees(), []);
			assert.isFalse(h.hasBranch(run.branch));
			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
		}),
	);

	it.effect('leaves a working agent alone even after its PR was closed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName, state: 'CLOSED' });
			yield* h.tick;
			assert.isTrue(open(h, run.tabId));
			assert.deepStrictEqual(h.worktrees(), [run.worktreePath]);

			h.herdr.setAgentStatus(run.paneId, 'idle');
			yield* h.tick;
			assert.isFalse(open(h, run.tabId));
			assert.deepStrictEqual(yield* h.runs, []);
		}),
	);

	it.effect('keeps a worktree with unpushed commits and says so once, also across restarts, until the work is pushed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

			git(run.worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
			h.moveEpic(epic.id, 'Shipped');
			yield* h.tick;
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['keptWorktree:0']);
			assert.include(h.notices(epic.identifier)[0].text, `📦 **Kept TEST-10's worktree**: it has 1 unpushed commit.\n- Worktree: \`${run.worktreePath}\``);
			assert.deepStrictEqual(h.linear.comments(epic.id), []);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['kept'],
			);
			assert.isTrue(existsSync(run.worktreePath));
			assert.isFalse(open(h, run.tabId));

			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees(), []);
			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['keptWorktree:0']);
		}),
	);

	it.effect('finishes the cleanup after a crash between closing the tab and removing the worktree, or before dropping the run', () =>
		Effect.gen(function* () {
			const injections: ReadonlyArray<[string, (h: Harness) => void]> = [
				['after closing the tab', (h) => h.herdr.crashAfterWrite(1, new Transient({ message: 'the process died' }))],
				['before dropping the run', (h) => h.crashAtJournalWrite(1)],
			];

			for (const [where, inject] of injections) {
				const h = yield* makeHarness();
				const { epic, run } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync', agentStatus: 'idle' });

				h.moveEpic(epic.id, 'Shipped');
				inject(h);
				yield* h.tick;
				assert.isFalse(open(h, run.tabId), where);
				assert.lengthOf(yield* h.runs, 1, where);

				yield* h.restart;
				yield* h.tick;

				assert.deepStrictEqual(h.worktrees(), [], where);
				assert.isFalse(h.hasBranch(run.branch), where);
				assert.deepStrictEqual(yield* h.runs, [], where);
			}
		}),
	);

	it.effect('resolves owned tabs that no run tracks, records no session for one Claude already runs in, and never touches a user tab', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const shipped = h.linear.addEpic({ identifier: 'TEST-20', title: 'Old run', state: 'Shipped' });
			const working = h.linear.addEpic({ identifier: 'TEST-21', title: 'Still busy', state: 'Shipped' });
			const active = h.linear.addEpic({ identifier: 'TEST-22', title: 'Lost track', state: 'Implementing' });
			h.linear.addEpic({ identifier: 'TEST-23', title: 'Never started', state: 'Implementing' });
			const idleTab = h.herdr.addTab({ label: 'TEST-20 Old run', agentStatus: 'idle' });
			const workingTab = h.herdr.addTab({ label: 'TEST-21 Still busy', agentStatus: 'working' });
			const activeTab = h.herdr.addTab({ label: 'TEST-22 Lost track', agentStatus: 'idle' });
			const emptyTab = h.herdr.addTab({ label: 'TEST-23 Never started', agent: null });
			const userTab = h.herdr.addTab({ label: 'notes', agentStatus: 'idle' });
			const otherWorkspace = h.herdr.addTab({ label: 'TEST-20 Old run', workspace: 'personal', agentStatus: 'idle' });

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.closedTabs(), [idleTab.tabId]);
			assert.isTrue(open(h, workingTab.tabId));
			assert.isTrue(open(h, userTab.tabId));
			assert.isTrue(open(h, otherWorkspace.tabId));
			assert.deepStrictEqual(h.notices(working.identifier).map(({ marker }) => marker), [`workingOrphan:${workingTab.tabId}`]);
			assert.deepStrictEqual(h.linear.comments(working.id), []);
			assert.deepStrictEqual(h.linear.comments(shipped.id), []);

			const runs = new Map((yield* h.runs).map((run) => [run.identifier, run]));
			const lostTrack = runs.get('TEST-22');
			const neverStarted = runs.get('TEST-23');

			assert.deepStrictEqual([...runs.keys()].toSorted(), ['TEST-22', 'TEST-23']);
			assert.isDefined(lostTrack);
			assert.isDefined(neverStarted);
			assert.deepStrictEqual([lostTrack.status, lostTrack.tabId, lostTrack.session], ['running', activeTab.tabId, null]);
			assert.deepStrictEqual([neverStarted.status, neverStarted.tabId], ['running', emptyTab.tabId]);
			assert.isNotNull(neverStarted.session);
			assert.deepStrictEqual(
				h.herdr.starts().map((start) => [start.paneId, start.args]),
				[[emptyTab.paneId, ['--session-id', neverStarted.session.id, '--name', 'test-23']]],
			);
			assert.strictEqual(h.linear.stateName(active.id), 'Implementing');
		}),
	);

	it.effect('removes an untracked worktree of a finished epic, keeps one with unsaved work, and leaves the rest alone', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const done = h.linear.addEpic({ identifier: 'TEST-30', title: 'Done long ago', state: 'Done' });
			const dirty = h.linear.addEpic({ identifier: 'TEST-31', title: 'Half pushed', state: 'Shipped' });
			const inProgress = h.linear.addEpic({ identifier: 'TEST-32', title: 'Worked on by hand', state: 'Implementing' });
			// Linear's branch names for these epics.
			const donePath = untrackedWorktree(h, 'mario/test-30-done-long-ago');
			const dirtyPath = untrackedWorktree(h, 'mario/test-31-half-pushed');
			const inProgressPath = untrackedWorktree(h, 'mario/test-32-worked-on-by-hand');
			const unrelatedPath = untrackedWorktree(h, 'mario/try-new-linter');

			git(dirtyPath, 'commit', '--quiet', '--allow-empty', '-m', 'Not pushed');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees().toSorted(), [dirtyPath, inProgressPath, unrelatedPath].toSorted());
			assert.isFalse(h.hasBranch('mario/test-30-done-long-ago'));
			assert.deepStrictEqual(h.notices(dirty.identifier).map(({ marker }) => marker), [`keptWorktree:${dirtyPath}`]);
			assert.deepStrictEqual(h.linear.comments(dirty.id), []);
			assert.deepStrictEqual([...h.linear.comments(done.id), ...h.linear.comments(inProgress.id)], []);
			assert.isFalse(existsSync(donePath));
		}),
	);
});
