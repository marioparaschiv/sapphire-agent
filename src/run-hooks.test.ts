import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, Option } from 'effect';
import { onTestFinished } from 'vitest';
import { testSettings } from './config.ts';
import { handoffPath } from './directories.ts';
import { Journal, journalPath } from './journal.ts';
import { piToolCall } from './pi-hooks.ts';
import { runHookAnswer, toolCallDecision } from './run-hooks.ts';
import { git, makeHarness } from './test-harness.ts';

const sessionId = '9b2f4c1e-3a7d-4e8b-b6c5-0d1e2f3a4b5c';

// A hook payload as Claude Code writes it on stdin.
const claudeHook = (cwd: string, event: string, fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		session_id: sessionId,
		transcript_path: `/home/dev/.claude/projects/-home-dev-unbound/${sessionId}.jsonl`,
		cwd,
		permission_mode: 'bypassPermissions',
		hook_event_name: event,
		...fields,
	});

const toolUse = (cwd: string, toolName: string, toolInput: Record<string, unknown>) =>
	claudeHook(cwd, 'PreToolUse', { tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_01HkqZ3vYb7mJ8xWn2pQ4rT5' });

const bash = (cwd: string, command: string) => toolUse(cwd, 'Bash', { command, description: 'Run git' });

const branch = 'mario/test-12-plugin-settings-sync';

// The Test team's clone of an origin whose default branch is main, a dispatched run's worktree on the epic branch and,
// with the clone parked on another branch, a dispatched worktree on main. config.json is AppConfig.layerTest's, and the
// journal has the Test project.
const setup = Effect.gen(function* () {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-run-hooks-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	const origin = join(dir, 'origin.git');
	const seed = join(dir, 'seed');
	const repo = join(dir, 'repo');
	const worktree = join(dir, 'worktrees', 'repo', 'mario-test-12-plugin-settings-sync');
	const mainWorktree = join(dir, 'worktrees', 'repo', 'main');

	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
	git(seed, 'push', '--quiet', origin, 'main');
	execFileSync('git', ['clone', '--quiet', origin, repo]);
	git(repo, 'checkout', '--quiet', '-b', 'parked');
	git(repo, 'worktree', 'add', '--quiet', '-b', branch, worktree, 'origin/main');
	git(repo, 'worktree', 'add', '--quiet', mainWorktree, 'main');
	writeFileSync(join(dir, 'config.json'), JSON.stringify(testSettings(dir)));
	yield* Journal.use((journal) => journal.putProjects([{ team: 'Test', repo, labelReposDirectory: null }])).pipe(Effect.provide(Journal.layer(journalPath(dir))));

	return { dir, repo, worktree, mainWorktree };
});

const hookEnv = (dir: string) => Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SAPPHIRE_AGENT_CONFIG_DIR: dir, SAPPHIRE_AGENT_STATE_DIR: dir })));

const answer = (dir: string, payload: string) => runHookAnswer(payload).pipe(Effect.map(Option.getOrUndefined), Effect.provide(hookEnv(dir)));

// What the Pi extension decides about a Pi tool call in `cwd`.
const piDecision = (dir: string, cwd: string, name: string, input: Record<string, unknown>) =>
	toolCallDecision(cwd, piToolCall(name, input)).pipe(Effect.map(Option.getOrUndefined), Effect.provide(hookEnv(dir)));

const refusalOf = (output: string | undefined) => {
	if (output === undefined) {
		return undefined;
	}

	const { hookSpecificOutput } = JSON.parse(output);

	assert.strictEqual(hookSpecificOutput.hookEventName, 'PreToolUse');
	assert.strictEqual(hookSpecificOutput.permissionDecision, 'deny');

	return String(hookSpecificOutput.permissionDecisionReason);
};

const outside = (target: string, worktree: string) =>
	`${target} is outside this run's worktree ${worktree}; a dispatched run only writes inside its worktree, ${tmpdir()} and ~/share`;

const bashRefusal = (dir: string, cwd: string, command: string) => answer(dir, bash(cwd, command)).pipe(Effect.map(refusalOf));

describe('run hooks', () => {
	it.effect('refuse pushes to the default branch and force pushes, and allow pushing the epic branch', () =>
		Effect.gen(function* () {
			const { dir, worktree, mainWorktree } = yield* setup;
			const toMain = 'pushing to main, the default branch, is not allowed in a dispatched run: push the epic branch and open a pull request';
			const force = 'force pushes are not allowed in a dispatched run: they rewrite what is on the remote';

			for (const command of [
				'git push origin main',
				'git push origin HEAD:main',
				`git push origin ${branch}:refs/heads/main`,
				'git push origin :main',
				'git status && git push origin main 2>&1 | tail -5',
				'GIT_TERMINAL_PROMPT=0 git push origin main',
				`cd /tmp; git -C ${worktree} push -u origin main`,
				`cd /tmp; env -C ${worktree} git push origin main`,
				"env -S 'git push origin main'",
				`cd /tmp && pushd ${mainWorktree} && git push`,
			]) {
				assert.strictEqual(yield* bashRefusal(dir, worktree, command), toMain, command);
			}

			assert.strictEqual(yield* bashRefusal(dir, mainWorktree, 'git push'), toMain);
			assert.strictEqual(yield* bashRefusal(dir, mainWorktree, 'git push -u origin HEAD'), toMain);

			for (const command of ['git push --force', 'git push -f origin HEAD', 'git push --force-with-lease origin HEAD', 'git push --force-w origin HEAD', `git push origin +${branch}`, 'git push -fu origin HEAD']) {
				assert.strictEqual(yield* bashRefusal(dir, worktree, command), force, command);
			}

			for (const command of ['git push --all origin', 'git push --al origin', "git push origin 'refs/heads/*:refs/heads/*'"]) {
				assert.strictEqual(yield* bashRefusal(dir, worktree, command), 'pushing every branch is not allowed in a dispatched run: it includes the default branch', command);
			}

			assert.strictEqual(
				yield* bashRefusal(dir, worktree, `git --git-dir=${join(dir, 'repo', '.git')} push origin main`),
				'git push, add and commit with `--git-dir`, `--work-tree`, GIT_DIR or GIT_WORK_TREE are not allowed in a dispatched run: the guard cannot tell which repository they act on',
			);

			for (const command of ['git push', 'git push -u origin HEAD', `git push origin ${branch}`, 'git push origin v1.2.0', 'echo "git push origin main --force"']) {
				assert.strictEqual(yield* bashRefusal(dir, worktree, command), undefined, command);
			}
		}),
	);

	it.effect('refuse staging or committing env files and keys, unless git ignores them', () =>
		Effect.gen(function* () {
			const { dir, worktree } = yield* setup;
			const refused = (files: string, action = 'git add') =>
				`${action} would include ${files}, which may hold secrets; env files and keys are never committed in a dispatched run`;

			mkdirSync(join(worktree, 'src'));
			writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
			writeFileSync(join(worktree, '.env'), 'DATABASE_URL=postgres://localhost/app\n');

			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add .env'), refused('.env'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add -A && git commit -m "Add settings sync"'), refused('.env'));
			assert.strictEqual(yield* bashRefusal(dir, join(worktree, 'src'), 'git add ..'), refused('../.env'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add .'), refused('.env'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git commit -m "Add config" .env.local'), refused('.env.local', 'git commit'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add src/ && git commit -m "Add index"'), undefined);
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add src/*.ts'), undefined);
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git commit -am "Update index"'), undefined);

			writeFileSync(join(worktree, '.gitignore'), '.env\n');

			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add -A'), undefined);
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add -f -A'), refused('.env'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add --al --force'), refused('.env'));

			mkdirSync(join(worktree, 'certs'));
			writeFileSync(join(worktree, 'certs', 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');
			git(worktree, 'add', 'certs/server.pem');

			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git commit -m "Add index"'), refused('certs/server.pem', 'git commit'));

			git(worktree, 'commit', '--quiet', '-m', 'Add a key by hand');
			writeFileSync(join(worktree, 'certs', 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIE\n');

			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git commit -am "Rotate"'), refused('certs/server.pem', 'git commit'));
			assert.strictEqual(yield* bashRefusal(dir, worktree, 'git add -u'), refused('certs/server.pem'));
		}),
	);

	it.effect("refuse writes outside the run's worktree and to env files and keys, and leave reading alone", () =>
		Effect.gen(function* () {
			const { dir, repo, worktree } = yield* setup;
			const write = (filePath: string) => answer(dir, toolUse(worktree, 'Write', { file_path: filePath, content: 'export {};\n' })).pipe(Effect.map(refusalOf));

			assert.strictEqual(yield* write(join(worktree, 'src', 'sync.ts')), undefined);
			assert.strictEqual(yield* write(handoffPath('TEST-12', sessionId)), undefined);
			assert.strictEqual(
				yield* write(join(repo, 'src', 'sync.ts')),
				outside(join(repo, 'src', 'sync.ts'), worktree),
			);
			assert.strictEqual(
				yield* answer(dir, toolUse(worktree, 'Edit', { file_path: '../main/README.md', old_string: 'a', new_string: 'b', replace_all: false })).pipe(Effect.map(refusalOf)),
				outside(join(dir, 'worktrees', 'repo', 'main', 'README.md'), worktree),
			);
			// Scratch: the temp directory and ~/share, but never a checkout in them, and never a secret.
			assert.strictEqual(yield* write(join(tmpdir(), 'pstack-swarm-run', 'brief.md')), undefined);
			assert.strictEqual(yield* write(join(homedir(), 'share', 'report', 'index.html')), undefined);
			assert.strictEqual(yield* write(join(tmpdir(), 'scratch', '.env')), '.env may hold secrets; a dispatched run never writes env files or keys (reading them is fine)');
			assert.strictEqual(yield* write(join(homedir(), 'notes.md')), outside(join(homedir(), 'notes.md'), worktree));
			assert.strictEqual(yield* write(join(worktree, '.env')), '.env may hold secrets; a dispatched run never writes env files or keys (reading them is fine)');
			assert.strictEqual(
				yield* answer(dir, toolUse(worktree, 'NotebookEdit', { notebook_path: join(worktree, 'id_ed25519'), new_source: 'x' })).pipe(Effect.map(refusalOf)),
				'id_ed25519 may hold secrets; a dispatched run never writes env files or keys (reading them is fine)',
			);
			assert.strictEqual(yield* answer(dir, toolUse(worktree, 'Read', { file_path: join(worktree, '.env') })), undefined);
		}),
	);

	it.effect("leave sessions outside a dispatched worktree alone, a T3 worktree of a repo that is no project's included", () =>
		Effect.gen(function* () {
			const { dir, repo } = yield* setup;
			const otherWorktree = join(dir, 'worktrees', 'telecord', 'main');

			mkdirSync(otherWorktree, { recursive: true });

			assert.strictEqual(yield* answer(dir, bash(otherWorktree, 'git push --force origin main')), undefined);
			assert.strictEqual(yield* answer(dir, bash(repo, 'git push --force origin main')), undefined);
			assert.strictEqual(yield* answer(dir, toolUse(repo, 'Write', { file_path: '/tmp/notes.md', content: 'x' })), undefined);
		}),
	);

	it.effect("guard Pi's tool calls with the same rules: its shell and file writes in a run, its read tools in a command thread", () =>
		Effect.gen(function* () {
			const { dir, repo, worktree } = yield* setup;
			const checkout = join(dir, 'commands', 'repo');
			const refused = outside(join(repo, 'src', 'sync.ts'), worktree);

			assert.deepStrictEqual(yield* piDecision(dir, worktree, 'bash', { command: 'git push --force origin HEAD' }), {
				allow: false,
				reason: 'force pushes are not allowed in a dispatched run: they rewrite what is on the remote',
			});
			assert.deepStrictEqual(yield* piDecision(dir, worktree, 'write', { path: join(repo, 'src', 'sync.ts'), content: 'x' }), { allow: false, reason: refused });
			assert.deepStrictEqual(yield* piDecision(dir, worktree, 'edit', { path: '.env', edits: [] }), {
				allow: false,
				reason: '.env may hold secrets; a dispatched run never writes env files or keys (reading them is fine)',
			});
			assert.isUndefined(yield* piDecision(dir, worktree, 'edit', { path: 'src/sync.ts', edits: [] }));
			assert.isUndefined(yield* piDecision(dir, worktree, 'read', { path: '.env' }));
			assert.isUndefined(yield* piDecision(dir, repo, 'bash', { command: 'git push --force origin main' }));

			assert.deepStrictEqual(yield* piDecision(dir, checkout, 'grep', { pattern: 'x' }), { allow: true, reason: 'a command agent may use grep' });
			assert.deepStrictEqual(yield* piDecision(dir, checkout, 'bash', { command: 'git log --oneline -5' }), { allow: true, reason: 'a read-only command of the command agent' });
			assert.deepStrictEqual(yield* piDecision(dir, checkout, 'write', { path: 'README.md', content: 'x' }), { allow: false, reason: 'a command agent only reads: write is not allowed' });
			assert.deepStrictEqual(yield* piDecision(dir, checkout, 'codemode', { code: 'return 1' }), { allow: false, reason: 'a command agent only reads: codemode is not allowed' });
		}),
	);

	it.effect('guard through `sapphire hook claude` without the service', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const worktree = join(h.dir, 'worktrees', 'repo', 'mario-test-12-plugin-settings-sync');

			git(h.repo, 'worktree', 'add', '--quiet', '-b', branch, worktree, 'origin/main');
			yield* h.stop;

			const inRun = yield* h.hook('claude', bash(worktree, 'git push origin main'));
			const elsewhere = yield* h.hook('claude', bash(h.repo, 'git push origin main'));

			assert.deepStrictEqual(inRun, {
				code: 0,
				stdout: `${JSON.stringify({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						permissionDecisionReason: 'pushing to main, the default branch, is not allowed in a dispatched run: push the epic branch and open a pull request',
					},
				})}\n`,
				stderr: '',
			});
			assert.deepStrictEqual(elsewhere, { code: 0, stdout: '', stderr: '' });
		}),
	);

	it.effect("answer a command thread's tool calls through `sapphire hook claude`: read-only ones run without asking, anything else is refused", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const checkout = join(h.dir, 'commands', 'repo');
			const answer = (payload: string) => h.hook('claude', payload).pipe(Effect.map(({ stdout }) => JSON.parse(stdout).hookSpecificOutput.permissionDecision));

			assert.strictEqual(yield* answer(bash(checkout, 'gh pr view 3 --comments')), 'allow');
			assert.strictEqual(yield* answer(bash(join(checkout, 'src'), 'git log --oneline -5')), 'allow');
			assert.strictEqual(yield* answer(bash(checkout, 'git push origin HEAD')), 'deny');
			assert.strictEqual(yield* answer(bash(checkout, 'git commit -am "Rename it"')), 'deny');
			assert.strictEqual(yield* answer(toolUse(checkout, 'Edit', { file_path: join(checkout, 'README.md'), old_string: 'a', new_string: 'b' })), 'deny');
			assert.deepStrictEqual(yield* h.hook('claude', bash(h.repo, 'git commit -am "Rename it"')), { code: 0, stdout: '', stderr: '' });
		}),
	);
});
