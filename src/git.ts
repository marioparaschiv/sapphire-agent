import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
	const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);

	return stdout.trim();
}

const succeeds = (promise: Promise<unknown>) => promise.then(
	() => true,
	() => false,
);

// Same layout as herdr's own worktrees: <directory>/<repo>/<branch-slug>.
export const worktreePath = (worktreesDirectory: string, repoPath: string, branch: string) =>
	join(worktreesDirectory, basename(repoPath), branch.replace(/[^A-Za-z0-9._-]+/g, '-'));

export function parseGithubRepo(remoteUrl: string) {
	const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);

	if (!match) {
		throw new Error(`origin ${remoteUrl} is not a GitHub repository`);
	}

	return match[1];
}

export async function githubRepo(repoPath: string) {
	return parseGithubRepo(await git(repoPath, ['remote', 'get-url', 'origin']));
}

async function defaultBranch(repoPath: string) {
	const read = () => git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);

	try {
		return await read();
	} catch {
		await git(repoPath, ['remote', 'set-head', 'origin', '--auto']);

		return read();
	}
}

// Checks the branch out in its own worktree, reusing the checkout from an earlier attempt. A new branch starts
// from the freshly fetched default branch without tracking it, so a plain push never targets the default branch.
export async function prepareWorktree(repoPath: string, branch: string, worktreesDirectory: string) {
	const path = worktreePath(worktreesDirectory, repoPath, branch);

	await git(repoPath, ['fetch', 'origin']);

	if (await succeeds(access(path))) {
		const checkedOut = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);

		if (checkedOut !== branch) {
			throw new Error(`${path} already exists with ${checkedOut} checked out instead of ${branch}`);
		}

		return path;
	}

	if (await succeeds(git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]))) {
		await git(repoPath, ['worktree', 'add', path, branch]);
	} else if (await succeeds(git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]))) {
		await git(repoPath, ['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
	} else {
		await git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, path, await defaultBranch(repoPath)]);
	}

	return path;
}
