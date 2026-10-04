import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parseGithubRepo, prepareWorktree, pullBranch, readResultFile, removeWorktree, resultFilePath, unsavedWork } from './git.ts';

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

const hasBranch = (repo: string, branch: string) => git(repo, 'branch', '--list', branch) !== '';

test('removes a worktree whose work is all on origin, ignored files included, and does nothing the second time', async (t) => {
	const { repo, worktrees } = repos(t);
	const branch = 'mario/unb-16';
	const path = await prepareWorktree(repo, branch, worktrees);
	writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
	git(path, 'add', '.gitignore');
	git(path, 'commit', '--quiet', '-m', 'ignore deps');
	git(path, 'push', '--quiet', '-u', 'origin', branch);
	mkdirSync(join(path, 'node_modules'));
	writeFileSync(join(path, 'node_modules', 'dep.js'), '');

	assert.equal(await unsavedWork(repo, branch, path), undefined);
	await removeWorktree(repo, branch, path);

	assert.equal(existsSync(path), false);
	assert.equal(hasBranch(repo, branch), false);
	assert.equal(await unsavedWork(repo, branch, path), undefined);
	await removeWorktree(repo, branch, path);
	assert.equal(await prepareWorktree(repo, branch, worktrees), path, 'a later run restores it from origin');
	assert.equal(git(path, 'log', '-1', '--format=%s'), 'ignore deps');
});

test('reports uncommitted changes and unpushed commits, including on a branch never pushed', async (t) => {
	const { repo, worktrees } = repos(t);
	const branch = 'mario/unb-17';
	const path = await prepareWorktree(repo, branch, worktrees);

	assert.equal(await unsavedWork(repo, branch, path), undefined, 'a new branch with nothing on it');

	writeFileSync(join(path, 'notes.md'), 'draft');
	assert.equal(await unsavedWork(repo, branch, path), 'uncommitted changes');

	git(path, 'add', 'notes.md');
	git(path, 'commit', '--quiet', '-m', 'slice 1');
	git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 2');
	assert.equal(await unsavedWork(repo, branch, path), '2 unpushed commits');

	git(path, 'push', '--quiet', '-u', 'origin', branch);
	git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 3');
	assert.equal(await unsavedWork(repo, branch, path), '1 unpushed commit');
});

test('checks the branch when its worktree directory was deleted by hand, then removes it', async (t) => {
	const { repo, worktrees } = repos(t);
	const branch = 'mario/unb-18';
	const path = await prepareWorktree(repo, branch, worktrees);
	git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
	rmSync(path, { recursive: true, force: true });

	assert.equal(await unsavedWork(repo, branch, path), '1 unpushed commit');

	git(repo, 'push', '--quiet', 'origin', branch);
	assert.equal(await unsavedWork(repo, branch, path), undefined);
	await removeWorktree(repo, branch, path);
	assert.equal(hasBranch(repo, branch), false);
});

test('a follow-up restores a cleaned-up worktree from origin and pulls a reused one up to date', async (t) => {
	const { origin, seed, repo, worktrees } = repos(t);
	const branch = 'mario/unb-19';
	const path = await prepareWorktree(repo, branch, worktrees);
	git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
	git(path, 'push', '--quiet', 'origin', branch);
	await removeWorktree(repo, branch, path);
	assert.equal(existsSync(path), false);
	assert.equal(hasBranch(repo, branch), false);

	assert.equal(await prepareWorktree(repo, branch, worktrees), path);
	await pullBranch(path, branch);
	assert.equal(git(path, 'log', '-1', '--format=%s'), 'slice 1');

	git(seed, 'fetch', '--quiet', origin, branch);
	git(seed, 'checkout', '--quiet', '-b', branch, 'FETCH_HEAD');
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'pushed from elsewhere');
	git(seed, 'push', '--quiet', origin, branch);

	assert.equal(await prepareWorktree(repo, branch, worktrees), path);
	await pullBranch(path, branch);
	assert.equal(git(path, 'log', '-1', '--format=%s'), 'pushed from elsewhere');
});

test('reads owner/repo from GitHub remotes', () => {
	assert.equal(parseGithubRepo('https://github.com/marioparaschiv/unbound.git'), 'marioparaschiv/unbound');
	assert.equal(parseGithubRepo('https://github.com/marioparaschiv/hivemind.ts'), 'marioparaschiv/hivemind.ts');
	assert.equal(parseGithubRepo('git@github.com:unbound-app/loader-ios.git'), 'unbound-app/loader-ios');
	assert.throws(() => parseGithubRepo('https://gitlab.com/someone/thing.git'), /not a GitHub repository/);
});

test('reads the result file from the worktree\'s git dir, where it can never be committed', async (t) => {
	const { repo, worktrees } = repos(t);
	const path = await prepareWorktree(repo, 'mario/unb-14', worktrees);
	const resultPath = await resultFilePath(path);

	assert.equal(resultPath, join(repo, '.git', 'worktrees', 'mario-unb-14', 'herdr-result.json'));
	assert.equal(await readResultFile(path), undefined);

	writeFileSync(resultPath, JSON.stringify({ summary: 'Done.', flags: [] }));
	const missingReplies = await readResultFile(path);
	assert.ok(missingReplies && !missingReplies.ok && /replies/.test(missingReplies.error), JSON.stringify(missingReplies));

	writeFileSync(resultPath, '{ "summary": ');
	const notJson = await readResultFile(path);
	assert.ok(notJson && !notJson.ok && notJson.error.startsWith('not JSON'), JSON.stringify(notJson));

	const result = { summary: 'Done.', replies: [], flags: [{ path: 'src/a.ts', line: 3, body: 'Rename this.' }] };
	writeFileSync(resultPath, JSON.stringify(result));
	assert.deepEqual(await readResultFile(path), { ok: true, result });
	assert.equal(git(path, 'status', '--porcelain', '--ignored'), '');
});
