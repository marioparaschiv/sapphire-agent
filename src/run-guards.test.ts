import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { onTestFinished } from 'vitest';
import { ctlPath } from './directories.ts';
import { commandToolDecision, isCommandCwd, isProjectRepo, worktreeOf } from './run-guards.ts';

const directory = () => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-guards-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	return dir;
};

describe('worktreeOf', () => {
	it('finds the worktree root from anywhere inside it', () => {
		const worktreesDirectory = join(directory(), 'worktrees');

		assert.deepStrictEqual(worktreeOf(worktreesDirectory, join(worktreesDirectory, 'unbound', 'mario-hl-60-guards', 'src', 'lib')), {
			worktree: join(worktreesDirectory, 'unbound', 'mario-hl-60-guards'),
			repoName: 'unbound',
		});
	});

	it('leaves the worktrees directory, a repo directory in it and paths beside it alone', () => {
		const worktreesDirectory = join(directory(), 'worktrees');

		for (const cwd of [worktreesDirectory, join(worktreesDirectory, 'unbound'), `${worktreesDirectory}-old/unbound/x`, '/home/dev/unbound']) {
			assert.strictEqual(worktreeOf(worktreesDirectory, cwd), undefined, cwd);
		}
	});
});

describe('isProjectRepo', () => {
	it("knows a project's repo and the repos under its label repos directory, and nothing else", () => {
		const dir = directory();
		const labelReposDirectory = join(dir, 'libs');
		const projects = [{ team: 'Test', repo: join(dir, 'unbound'), labelReposDirectory }];

		mkdirSync(join(labelReposDirectory, 'loader'), { recursive: true });

		assert.deepStrictEqual(
			['unbound', 'loader', 'telecord'].map((name) => isProjectRepo(projects, name)),
			[true, true, false],
		);
	});
});

describe('commandToolDecision', () => {
	it("allows a command thread the CLI, the read-only gh and git subcommands and the read tools, alone or chained", () => {
		for (const command of [
			`sh ${ctlPath} status`,
			`sh ${ctlPath} reply https://github.com/test/repo/pull/3#issuecomment-1 'Nothing is running.'`,
			'gh pr view 3 --comments',
			'gh pr diff 3',
			'gh pr checks 3',
			'gh issue view 7',
			'git log --oneline -20',
			'git show HEAD~1',
			'git diff main...HEAD -- src',
			'git status',
			'gh pr view 3 && git log -3 2>&1',
			`sh ${ctlPath} reply https://github.com/test/repo/pull/3#issuecomment-1 '> Can you rerun it?\n\nRerunning it now.'`,
			"git log --format='$(not run)'",
		]) {
			assert.isTrue(commandToolDecision('Bash', command).allow, command);
		}

		for (const tool of ['Read', 'Grep', 'Glob', 'SendMessage']) {
			assert.isTrue(commandToolDecision(tool, undefined).allow, tool);
		}
	});

	it('refuses a command thread anything that writes or runs something else', () => {
		for (const command of [
			'git push origin HEAD',
			'git commit -am "Fix it"',
			'git checkout -b fix',
			'gh pr merge 3 --squash',
			'gh pr comment 3 --body hi',
			'gh api repos/test/repo/pulls/3/merge -X PUT',
			'git diff --output=/tmp/patch',
			'git log > /tmp/log.txt',
			'git show HEAD >> notes.md',
			'git status; rm -rf src',
			'git log | head -5',
			'echo $(git push)',
			'gh pr view "$(rm -rf src)"',
			'gh pr view "`rm -rf src`"',
			'sh scripts/other.sh',
			'npm test',
		]) {
			assert.isFalse(commandToolDecision('Bash', command).allow, command);
		}

		for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']) {
			assert.isFalse(commandToolDecision(tool, undefined).allow, tool);
		}

		assert.deepStrictEqual(commandToolDecision('Bash', 'gh pr view 3 && gh pr merge 3'), {
			allow: false,
			reason: `a command agent only runs \`sh ${ctlPath} ...\` and gh pr view, gh pr diff, gh pr checks, gh issue view, git log, git show, git diff, git status: \`gh pr merge 3\` is not allowed`,
		});
	});

	it("knows a command thread by its cwd under the state directory's commands", () => {
		assert.isTrue(isCommandCwd('/home/dev/.local/state/sapphire', '/home/dev/.local/state/sapphire/commands'));
		assert.isTrue(isCommandCwd('/home/dev/.local/state/sapphire', '/home/dev/.local/state/sapphire/commands/repo/src'));
		assert.isFalse(isCommandCwd('/home/dev/.local/state/sapphire', '/home/dev/.local/state/sapphire'));
		assert.isFalse(isCommandCwd('/home/dev/.local/state/sapphire', '/home/dev/.local/state/sapphire/commands-old'));
		assert.isFalse(isCommandCwd('/home/dev/.local/state/sapphire', '/home/dev/sapphire-agent'));
	});
});
