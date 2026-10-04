import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parseGithubRepo, prepareWorktree } from './git.ts';

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
		encoding: 'utf8',
	}).trim();

// An origin with a main branch, a clone of it, and an empty worktrees directory.
function repos(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-git-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const origin = join(dir, 'origin.git');
	const seed = join(dir, 'seed');
	const repo = join(dir, 'unbound');

	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
	git(seed, 'push', '--quiet', origin, 'main');
	execFileSync('git', ['clone', '--quiet', origin, repo]);
	// A commit that lands after the clone: the worktree must start from it, not from the stale local main.
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'after clone');
	git(seed, 'push', '--quiet', origin, 'main');

	return { origin, seed, repo, worktrees: join(dir, 'worktrees') };
}

test('creates the epic branch from the fetched default branch, without tracking it', async (t) => {
	const { seed, repo, worktrees } = repos(t);

	const path = await prepareWorktree(repo, 'mario/unb-12-settings-sync', worktrees);

	assert.equal(path, join(worktrees, 'unbound', 'mario-unb-12-settings-sync'));
	assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'mario/unb-12-settings-sync');
	assert.equal(git(path, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
	assert.throws(() => git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'));
});

test('reuses the worktree from an earlier attempt, and refuses one on another branch', async (t) => {
	const { repo, worktrees } = repos(t);
	const path = await prepareWorktree(repo, 'mario/unb-12', worktrees);
	git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
	const head = git(path, 'rev-parse', 'HEAD');

	assert.equal(await prepareWorktree(repo, 'mario/unb-12', worktrees), path);
	assert.equal(git(path, 'rev-parse', 'HEAD'), head);

	git(path, 'checkout', '--quiet', '-b', 'something-else');
	await assert.rejects(prepareWorktree(repo, 'mario/unb-12', worktrees), /checked out instead of mario\/unb-12/);
});

test('picks up a branch that already exists on origin', async (t) => {
	const { seed, repo, worktrees } = repos(t);
	git(seed, 'checkout', '--quiet', '-b', 'mario/unb-13');
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'pushed from elsewhere');
	git(seed, 'push', '--quiet', join(repo, '..', 'origin.git'), 'mario/unb-13');

	const path = await prepareWorktree(repo, 'mario/unb-13', worktrees);

	assert.equal(git(path, 'log', '-1', '--format=%s'), 'pushed from elsewhere');
	assert.equal(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/mario/unb-13');
});

test('finds the default branch when origin/HEAD was never set', async (t) => {
	const { origin, repo, worktrees } = repos(t);
	const bare = join(repo, '..', 'no-head');
	execFileSync('git', ['init', '--quiet', '--initial-branch=trunk', bare]);
	git(bare, 'remote', 'add', 'origin', origin);

	const path = await prepareWorktree(bare, 'mario/unb-14', worktrees);

	assert.equal(git(path, 'log', '-1', '--format=%s'), 'after clone');
	assert.equal(git(bare, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main');
	await assert.rejects(prepareWorktree(join(repo, '..', 'missing'), 'mario/unb-15', worktrees));
});

test('reads owner/repo from GitHub remotes', () => {
	assert.equal(parseGithubRepo('https://github.com/marioparaschiv/unbound.git'), 'marioparaschiv/unbound');
	assert.equal(parseGithubRepo('https://github.com/marioparaschiv/hivemind.ts'), 'marioparaschiv/hivemind.ts');
	assert.equal(parseGithubRepo('git@github.com:unbound-app/loader-ios.git'), 'unbound-app/loader-ios');
	assert.throws(() => parseGithubRepo('https://gitlab.com/someone/thing.git'), /not a GitHub repository/);
});
