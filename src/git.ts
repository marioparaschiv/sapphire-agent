import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { type ResultFile, resultFileSchema } from './protocol.ts';

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

const branchExists = (repoPath: string, branch: string) =>
	succeeds(git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]));

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

	if (await branchExists(repoPath, branch)) {
		await git(repoPath, ['worktree', 'add', path, branch]);
	} else if (await succeeds(git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]))) {
		await git(repoPath, ['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
	} else {
		await git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, path, await defaultBranch(repoPath)]);
	}

	return path;
}

// Names origin explicitly: a branch created without tracking has no upstream to pull from.
export async function pullBranch(path: string, branch: string) {
	await git(path, ['pull', '--ff-only', 'origin', branch]);
}

// Why the epic's worktree and branch cannot be deleted without losing work, or undefined when everything in them
// is on origin. A commit counts as pushed when any origin branch contains it, so a branch never pushed is unsaved
// as soon as it has commits beyond the default branch.
export async function unsavedWork(repoPath: string, branch: string, path: string) {
	const hasWorktree = await succeeds(access(path));

	if (hasWorktree && (await git(path, ['status', '--porcelain']))) {
		return 'uncommitted changes';
	}

	const heads = [...(hasWorktree ? ['HEAD'] : []), ...((await branchExists(repoPath, branch)) ? [`refs/heads/${branch}`] : [])];

	if (heads.length === 0) {
		return undefined;
	}

	const unpushed = Number(await git(hasWorktree ? path : repoPath, ['rev-list', '--count', ...heads, '--not', '--remotes=origin']));

	return unpushed > 0 ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}` : undefined;
}

// Removes the worktree and deletes the local branch, so a later run starts again from origin. Either may already be
// gone. Callers check unsavedWork first; `worktree remove` without --force still refuses a dirty worktree.
export async function removeWorktree(repoPath: string, branch: string, path: string) {
	if (await succeeds(access(path))) {
		await git(repoPath, ['worktree', 'remove', path]);
	}

	// A worktree directory deleted by hand stays registered, and git refuses to delete a branch checked out there.
	await git(repoPath, ['worktree', 'prune']);

	if (await branchExists(repoPath, branch)) {
		await git(repoPath, ['branch', '--delete', '--force', branch]);
	}
}

// The agent writes its result into the worktree's own git dir (`.git` is a file in a linked worktree), so it can
// never be committed. The orchestrate skill resolves the same path with `git rev-parse --git-dir`.
export const resultFilePath = async (path: string) => join(await git(path, ['rev-parse', '--absolute-git-dir']), 'herdr-result.json');

type ResultFileRead = { ok: true; result: ResultFile } | { ok: false; error: string };

// Undefined while the agent has not written the file.
export async function readResultFile(path: string): Promise<ResultFileRead | undefined> {
	const text = await readFile(await resultFilePath(path), 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') {
			return undefined;
		}

		throw error;
	});

	if (text === undefined) {
		return undefined;
	}

	let json: unknown;

	try {
		json = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `not JSON: ${(error as Error).message}` };
	}

	const parsed = resultFileSchema.safeParse(json);

	return parsed.success ? { ok: true, result: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}
