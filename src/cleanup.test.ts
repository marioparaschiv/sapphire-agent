import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { git, type Harness, makeHarness } from './test-harness.ts';

// A worktree as T3 lays it out for sapphire-agent, on a new branch from origin/main, with no run tracking it.
const untrackedWorktree = (h: Harness, branch: string) => {
	const path = join(h.dir, 'worktrees', 'repo', branch.replace(/[^A-Za-z0-9._-]+/g, '-'));

	git(h.repo, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, 'origin/main');

	return path;
};

const settled = (h: Harness, threadId: string) => h.t3.thread(threadId).pipe(Effect.map(Option.map((thread) => thread.settled)));

describe('cleanup', () => {
	it.effect('leaves a working agent alone even after its PR was closed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'running');
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, state: 'CLOSED' });
			yield* h.tick;
			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(false));
			assert.deepStrictEqual(h.worktrees(), [run.worktreePath]);

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.tick;
			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(true));
			assert.deepStrictEqual(h.worktrees(), []);
			assert.deepStrictEqual(yield* h.runs, []);
		}),
	);

	it.effect('keeps a worktree with unpushed commits and says so once, also across restarts, until the work is pushed', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			git(run.worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
			h.moveEpic(epic.id, 'Shipped');
			yield* h.tick;
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['keptWorktree:0']);
			assert.include(h.notices(epic.identifier)[0].text, `📦 **Kept TEST-10's worktree**: it has 1 unpushed commit.\n- Worktree: \`${run.worktreePath}\``);
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['keptWorktree:0']);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['kept'],
			);
			assert.isTrue(existsSync(run.worktreePath));

			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees(), []);
			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(h.notices(epic.identifier).map(({ marker }) => marker), ['keptWorktree:0']);
		}),
	);

	it.effect('finishes the cleanup after a crash between settling the thread and recording it, or before dropping the run', () =>
		Effect.gen(function* () {
			const injections: ReadonlyArray<[string, (h: Harness) => void]> = [
				['before recording the settled thread', (h) => h.crashAtJournalWrite(1)],
				['before dropping the run', (h) => h.crashAtJournalWrite(2)],
			];

			for (const [where, inject] of injections) {
				const h = yield* makeHarness();
				const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

				yield* h.t3.setRunStatus(run.threadId, 'completed');
				h.moveEpic(epic.id, 'Shipped');
				inject(h);
				yield* h.tick;
				assert.isTrue(h.crashed(), where);
				assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(true), where);
				assert.lengthOf(yield* h.runs, 1, where);

				yield* h.restart;
				yield* h.tick;

				assert.deepStrictEqual(h.worktrees(), [], where);
				assert.isFalse(h.hasBranch(run.branch), where);
				assert.deepStrictEqual(yield* h.runs, [], where);
			}
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
			assert.deepStrictEqual(h.epicMarkers(dirty.id), [`keptWorktree:${dirtyPath}`]);
			assert.deepStrictEqual([...h.linear.comments(done.id), ...h.linear.comments(inProgress.id)], []);
			assert.isFalse(existsSync(donePath));
		}),
	);

	it.effect('once the PR is merged, settles the thread, then removes the worktree and branch and drops the run', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			git(run.worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);

			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch });

			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.tick;
			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(false));

			h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED', git(run.worktreePath, 'rev-parse', 'HEAD'));
			yield* h.tick;

			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(true));
			assert.deepStrictEqual(h.worktrees(), []);
			assert.isFalse(h.hasBranch(run.branch));
			assert.deepStrictEqual(yield* h.runs, []);
			assert.deepStrictEqual(h.pushover.sent(), []);
		}),
	);

	it.effect('removes the worktree of a squash-merged PR whose branch is gone from origin, and leaves a thread T3 settled as it is', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			git(run.worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);

			const head = git(run.worktreePath, 'rev-parse', 'HEAD');
			const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, headRefOid: head });

			// GitHub squashes the PR onto main and deletes its branch; the next fetch prunes it.
			git(h.origin, 'branch', '--delete', '--force', run.branch);
			git(h.repo, 'fetch', '--quiet', '--prune', 'origin');
			h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.t3.setSettled(run.threadId, true);
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees(), []);
			assert.isFalse(h.hasBranch(run.branch));
			assert.deepStrictEqual(yield* h.runs, []);
			assert.notInclude(yield* h.t3.calls, 't3_thread_organize');
			assert.deepStrictEqual(h.notices(epic.identifier), []);
		}),
	);

	it.effect('keeps a worktree with unpushed work with one notice on the epic and one on the phone, leaves it while the user un-settled the thread, and removes it once pushed and settled', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			git(run.worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
			h.github.addPullRequest({ repo: h.githubRepo, branch: run.branch, state: 'CLOSED' });
			yield* h.t3.setRunStatus(run.threadId, 'completed');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(true));
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['keptWorktree:0']);
			assert.deepStrictEqual(h.pushover.sent(), [
				{
					title: "Kept TEST-10's worktree",
					message: `${run.worktreePath} has 1 unpushed commit. Push or discard that work; the worktree is removed on a later poll.`,
					url: 'https://linear.app/marioparaschiv/issue/TEST-10/plugin-settings-sync',
					priority: 'normal',
				},
			]);
			assert.deepStrictEqual(
				(yield* h.runs).map((found) => found.status),
				['kept'],
			);

			yield* h.t3.setSettled(run.threadId, false);
			git(run.worktreePath, 'push', '--quiet', 'origin', run.branch);
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees(), [run.worktreePath]);
			assert.deepStrictEqual(yield* settled(h, run.threadId), Option.some(false));

			yield* h.t3.setSettled(run.threadId, true);
			yield* h.tick;

			assert.deepStrictEqual(h.worktrees(), []);
			assert.deepStrictEqual(yield* h.runs, []);
			assert.lengthOf(h.pushover.sent(), 1);
		}),
	);
});
