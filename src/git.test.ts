import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Layer, Option } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { onTestFinished } from 'vitest';
import { Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Git, gitFailure, parseGithubRepo, type Worktree } from './git.ts';
import { InvalidResultFile } from './result-file.ts';
import { git } from './test-harness.ts';

// An origin with a main branch, a clone of it, and an empty worktrees directory under `dir`, which AppConfig.layerTest
// uses as its worktrees directory.
const repos = () => {
	const dir = mkdtempSync(join(tmpdir(), 'sapphire-agent-git-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

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

	return { dir, origin, seed, repo, worktrees: join(dir, 'worktrees') };
};

const gitLayer = (dir: string, spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = NodeServices.layer) =>
	Git.layer.pipe(Layer.provide(AppConfig.layerTest(dir)), Layer.provide(spawner), Layer.provide(NodeServices.layer));

const hasBranch = (repo: string, branch: string) => git(repo, 'branch', '--list', branch) !== '';

const describeCommand = (command: ChildProcess.Command) => (ChildProcess.isStandardCommand(command) ? command.args.join(' ') : '');

// The real spawner, recording every git command line (`-C <cwd> <args>`) as it starts. A command matching `block`
// signals `entered` and waits for `gate` before it starts.
const recordingSpawner = (options: { readonly started: Array<string>; readonly block?: string; readonly entered?: Deferred.Deferred<void>; readonly gate?: Deferred.Deferred<void> }) =>
	Layer.effect(
		ChildProcessSpawner.ChildProcessSpawner,
		Effect.gen(function* () {
			const real = yield* ChildProcessSpawner.ChildProcessSpawner;

			return ChildProcessSpawner.make((command) =>
				Effect.gen(function* () {
					const line = describeCommand(command);

					if (line === options.block && options.entered && options.gate) {
						yield* Deferred.succeed(options.entered, undefined);
						yield* Deferred.await(options.gate);
					}

					options.started.push(line);

					return yield* real.spawn(command);
				}),
			);
		}),
	).pipe(Layer.provide(NodeServices.layer));

describe('Git', () => {
	it.effect('creates the epic branch from the fetched default branch, without tracking it', () => {
		const { dir, seed, repo, worktrees } = repos();

		return Effect.gen(function* () {
			const path = yield* (yield* Git).prepareWorktree(repo, 'mario/unb-12-settings-sync');

			assert.strictEqual(path, join(worktrees, 'unbound', 'mario-unb-12-settings-sync'));
			assert.strictEqual(git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'mario/unb-12-settings-sync');
			assert.strictEqual(git(path, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
			assert.throws(() => git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'));
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('reuses the worktree from an earlier attempt, and refuses one on another branch', () => {
		const { dir, repo } = repos();

		return Effect.gen(function* () {
			const { prepareWorktree } = yield* Git;
			const path = yield* prepareWorktree(repo, 'mario/unb-12');

			git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
			const head = git(path, 'rev-parse', 'HEAD');

			assert.strictEqual(yield* prepareWorktree(repo, 'mario/unb-12'), path);
			assert.strictEqual(git(path, 'rev-parse', 'HEAD'), head);

			git(path, 'checkout', '--quiet', '-b', 'something-else');

			assert.deepStrictEqual(
				yield* Effect.exit(prepareWorktree(repo, 'mario/unb-12')),
				Exit.fail(new Permanent({ message: `${path} already exists with something-else checked out instead of mario/unb-12` })),
			);
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('picks up a branch that already exists on origin, tracking it', () => {
		const { dir, origin, seed, repo } = repos();

		git(seed, 'checkout', '--quiet', '-b', 'mario/unb-13');
		git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'pushed from elsewhere');
		git(seed, 'push', '--quiet', origin, 'mario/unb-13');

		return Effect.gen(function* () {
			const path = yield* (yield* Git).prepareWorktree(repo, 'mario/unb-13');

			assert.strictEqual(git(path, 'log', '-1', '--format=%s'), 'pushed from elsewhere');
			assert.strictEqual(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/mario/unb-13');
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('finds the default branch when origin/HEAD was never set, and fails a missing repo as Permanent', () => {
		const { dir, origin } = repos();
		const noHead = join(dir, 'no-head');
		const missing = join(dir, 'missing');

		execFileSync('git', ['init', '--quiet', '--initial-branch=trunk', noHead]);
		git(noHead, 'remote', 'add', 'origin', origin);

		return Effect.gen(function* () {
			const { prepareWorktree, defaultBranch } = yield* Git;
			const path = yield* prepareWorktree(noHead, 'mario/unb-14');

			assert.strictEqual(git(path, 'log', '-1', '--format=%s'), 'after clone');
			assert.strictEqual(git(noHead, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main');
			assert.strictEqual(yield* defaultBranch(noHead), 'main');

			const error = yield* Effect.flip(prepareWorktree(missing, 'mario/unb-15'));

			assert.strictEqual(error._tag, 'Permanent');
			assert.match(error.message, new RegExp(`^git -C ${missing} fetch origin failed with exit code 128: fatal: cannot change to '${missing}'`));
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('removes a worktree whose work is all on origin, ignored files included, and does nothing the second time', () => {
		const { dir, repo } = repos();
		const branch = 'mario/unb-16';

		return Effect.gen(function* () {
			const { prepareWorktree, unsavedWork, removeWorktree } = yield* Git;
			const path = yield* prepareWorktree(repo, branch);
			const other = yield* prepareWorktree(repo, 'mario/unb-99');
			const worktree: Worktree = { repo, branch, path };

			writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
			git(path, 'add', '.gitignore');
			git(path, 'commit', '--quiet', '-m', 'ignore deps');
			git(path, 'push', '--quiet', '-u', 'origin', branch);
			mkdirSync(join(path, 'node_modules'));
			writeFileSync(join(path, 'node_modules', 'dep.js'), '');

			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.none());
			yield* removeWorktree(worktree);

			assert.isFalse(existsSync(path));
			assert.isFalse(hasBranch(repo, branch));
			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.none());

			yield* removeWorktree(worktree);

			assert.isTrue(existsSync(other));
			assert.isTrue(hasBranch(repo, 'mario/unb-99'));
			assert.strictEqual(yield* prepareWorktree(repo, branch), path, 'a later run restores it from origin');
			assert.strictEqual(git(path, 'log', '-1', '--format=%s'), 'ignore deps');
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('reports uncommitted changes and unpushed commits, including on a branch never pushed', () => {
		const { dir, repo } = repos();
		const branch = 'mario/unb-17';

		return Effect.gen(function* () {
			const { prepareWorktree, unsavedWork } = yield* Git;
			const path = yield* prepareWorktree(repo, branch);
			const worktree: Worktree = { repo, branch, path };

			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.none(), 'a new branch with nothing on it');

			writeFileSync(join(path, 'notes.md'), 'draft');
			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.some('uncommitted changes'));

			git(path, 'add', 'notes.md');
			git(path, 'commit', '--quiet', '-m', 'slice 1');
			git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 2');
			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.some('2 unpushed commits'));

			git(path, 'push', '--quiet', '-u', 'origin', branch);
			git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 3');
			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.some('1 unpushed commit'));
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('checks the branch when its worktree directory was deleted by hand, then removes it', () => {
		const { dir, repo } = repos();
		const branch = 'mario/unb-18';

		return Effect.gen(function* () {
			const { prepareWorktree, unsavedWork, removeWorktree } = yield* Git;
			const path = yield* prepareWorktree(repo, branch);
			const worktree: Worktree = { repo, branch, path };

			git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
			rmSync(path, { recursive: true, force: true });

			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.some('1 unpushed commit'));

			git(repo, 'push', '--quiet', 'origin', branch);
			assert.deepStrictEqual(yield* unsavedWork(worktree), Option.none());

			yield* removeWorktree(worktree);
			assert.isFalse(hasBranch(repo, branch));
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('a follow-up restores a cleaned-up worktree from origin and pulls a reused one up to date', () => {
		const { dir, origin, seed, repo } = repos();
		const branch = 'mario/unb-19';

		return Effect.gen(function* () {
			const { prepareWorktree, pull, removeWorktree } = yield* Git;
			const path = yield* prepareWorktree(repo, branch);
			const worktree: Worktree = { repo, branch, path };

			git(path, 'commit', '--quiet', '--allow-empty', '-m', 'slice 1');
			git(path, 'push', '--quiet', 'origin', branch);
			yield* removeWorktree(worktree);
			assert.isFalse(existsSync(path));
			assert.isFalse(hasBranch(repo, branch));

			assert.strictEqual(yield* prepareWorktree(repo, branch), path);
			yield* pull(worktree);
			assert.strictEqual(git(path, 'log', '-1', '--format=%s'), 'slice 1');

			git(seed, 'fetch', '--quiet', origin, branch);
			git(seed, 'checkout', '--quiet', '-b', branch, 'FETCH_HEAD');
			git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'pushed from elsewhere');
			git(seed, 'push', '--quiet', origin, branch);

			assert.strictEqual(yield* prepareWorktree(repo, branch), path);
			yield* pull(worktree);
			assert.strictEqual(git(path, 'log', '-1', '--format=%s'), 'pushed from elsewhere');
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('lists the worktrees on a branch inside the worktrees directory, even when its configured path ends in a slash', () => {
		const { dir, repo, worktrees } = repos();
		const elsewhere = join(dir, 'elsewhere');

		return Effect.gen(function* () {
			const { prepareWorktree, listWorktrees } = yield* Git;
			const first = yield* prepareWorktree(repo, 'mario/unb-20');
			const second = yield* prepareWorktree(repo, 'mario/unb-21');

			git(repo, 'worktree', 'add', '--quiet', '-b', 'scratch', elsewhere);
			git(repo, 'worktree', 'add', '--quiet', '--detach', join(worktrees, 'unbound', 'detached'));
			rmSync(second, { recursive: true, force: true });

			assert.deepStrictEqual(yield* listWorktrees(repo), [
				{ repo, branch: 'mario/unb-20', path: first },
				{ repo, branch: 'mario/unb-21', path: second },
			]);
		}).pipe(
			Effect.provide(Git.layer.pipe(Layer.provide(AppConfig.layerTest(dir, { worktreesDirectory: `${worktrees}/` })), Layer.provide(NodeServices.layer))),
		);
	});

	it('reads owner/name from GitHub remotes', () => {
		assert.deepStrictEqual(parseGithubRepo('https://github.com/marioparaschiv/unbound.git'), Option.some('marioparaschiv/unbound'));
		assert.deepStrictEqual(parseGithubRepo('https://github.com/marioparaschiv/hivemind.ts'), Option.some('marioparaschiv/hivemind.ts'));
		assert.deepStrictEqual(parseGithubRepo('git@github.com:unbound-app/loader-ios.git'), Option.some('unbound-app/loader-ios'));
		assert.deepStrictEqual(parseGithubRepo('https://gitlab.com/someone/thing.git'), Option.none());
	});

	it.effect('reads the GitHub repo from origin, and fails a repo whose origin is not on GitHub', () => {
		const { dir, origin, repo } = repos();
		const github = join(dir, 'github');

		execFileSync('git', ['init', '--quiet', github]);
		git(github, 'remote', 'add', 'origin', 'git@github.com:unbound-app/loader-ios.git');

		return Effect.gen(function* () {
			const { githubRepo } = yield* Git;

			assert.strictEqual(yield* githubRepo(github), 'unbound-app/loader-ios');
			assert.deepStrictEqual(yield* Effect.exit(githubRepo(repo)), Exit.fail(new Permanent({ message: `origin ${origin} is not a GitHub repository` })));
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect("reads the result file from the worktree's git dir, where it can never be committed", () => {
		const { dir, repo } = repos();

		return Effect.gen(function* () {
			const { prepareWorktree, readResultFile, removeResultFile } = yield* Git;
			const path = yield* prepareWorktree(repo, 'mario/unb-14');
			const worktree: Worktree = { repo, branch: 'mario/unb-14', path };
			const resultPath = join(repo, '.git', 'worktrees', 'mario-unb-14', 'sapphire-agent-result.json');

			assert.deepStrictEqual(yield* readResultFile(worktree), Option.none());

			writeFileSync(resultPath, JSON.stringify({ summary: 'Done.', flags: [] }));
			const missingReplies = yield* Effect.flip(readResultFile(worktree));

			assert.instanceOf(missingReplies, InvalidResultFile);
			assert.match(missingReplies.message, /replies/);

			writeFileSync(resultPath, '{ "summary": ');
			const notJson = yield* Effect.flip(readResultFile(worktree));

			assert.instanceOf(notJson, InvalidResultFile);
			assert.match(notJson.message, /JSON/);

			const result = { summary: 'Done.', replies: [], flags: [{ path: 'src/a.ts', line: 3, body: 'Rename this.' }] };

			writeFileSync(resultPath, JSON.stringify(result));
			assert.deepStrictEqual(yield* readResultFile(worktree), Option.some(result));
			assert.strictEqual(git(path, 'status', '--porcelain', '--ignored'), '');

			yield* removeResultFile(worktree);
			assert.isFalse(existsSync(resultPath));
			yield* removeResultFile(worktree);
		}).pipe(Effect.provide(gitLayer(dir)));
	});

	it.effect('runs operations on one repo one after the other, and on two repos at the same time', () => {
		const { dir, origin, repo } = repos();
		const telecord = join(dir, 'telecord');

		execFileSync('git', ['clone', '--quiet', origin, telecord]);

		return Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const gate = yield* Deferred.make<void>();
			const started: Array<string> = [];
			const first: Worktree = { repo, branch: 'mario/unb-30', path: join(dir, 'worktrees', 'unbound', 'mario-unb-30') };
			const other: Worktree = { repo: telecord, branch: 'mario/tel-3', path: join(dir, 'worktrees', 'telecord', 'mario-tel-3') };
			const spawner = recordingSpawner({ started, block: `-C ${first.path} status --porcelain`, entered, gate });

			yield* Effect.gen(function* () {
				const { prepareWorktree, unsavedWork, listWorktrees } = yield* Git;

				yield* prepareWorktree(first.repo, first.branch);
				yield* prepareWorktree(other.repo, other.branch);
				started.length = 0;

				const blocked = yield* Effect.forkChild(unsavedWork(first));

				yield* Deferred.await(entered);

				const sameRepo = yield* Effect.forkChild(listWorktrees(repo));

				assert.deepStrictEqual(yield* unsavedWork(other), Option.none(), 'the other repo is not held up');
				assert.deepStrictEqual(started, [`-C ${other.path} status --porcelain`, `-C ${telecord} show-ref --verify --quiet refs/heads/mario/tel-3`, `-C ${other.path} rev-list --count HEAD refs/heads/mario/tel-3 --not --remotes=origin`]);

				yield* Deferred.succeed(gate, undefined);

				assert.deepStrictEqual(yield* Fiber.join(blocked), Option.none());
				assert.deepStrictEqual(yield* Fiber.join(sameRepo), [first]);
				assert.deepStrictEqual(started.slice(3), [
					`-C ${first.path} status --porcelain`,
					`-C ${repo} show-ref --verify --quiet refs/heads/mario/unb-30`,
					`-C ${first.path} rev-list --count HEAD refs/heads/mario/unb-30 --not --remotes=origin`,
					`-C ${repo} worktree list --porcelain`,
				]);
			}).pipe(Effect.provide(gitLayer(dir, spawner)));
		});
	});

	it('classifies a git lock and a network failure as Transient, anything else as Permanent', () => {
		const { dir, repo } = repos();
		const branch = 'mario/unb-40';
		const failure = (cwd: string, ...args: Array<string>) => {
			const { status, stderr } = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

			return gitFailure(cwd, args, status ?? -1, stderr.trim());
		};

		git(repo, 'branch', branch);
		writeFileSync(join(repo, '.git', 'refs', 'heads', 'mario', 'unb-40.lock'), '');

		const locked = failure(repo, 'branch', '--delete', '--force', branch);

		assert.instanceOf(locked, Transient);
		assert.match(locked.message, new RegExp(`^git -C ${repo} branch --delete --force mario/unb-40 failed with exit code \\d+: .*unb-40\\.lock': File exists`, 's'));

		git(repo, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/unbound.git');
		assert.instanceOf(failure(repo, 'fetch', 'origin'), Transient);
		assert.instanceOf(failure(repo, 'fetch', 'nowhere'), Permanent);
		assert.instanceOf(failure(join(dir, 'missing'), 'status', '--porcelain'), Permanent);
	});
});
