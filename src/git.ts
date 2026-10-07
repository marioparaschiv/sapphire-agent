import { basename, join, resolve, sep } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Semaphore, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { type CallError, callTimeouts, fileSystemFailure, Permanent, Transient, withCallPolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { decodeResultFile, type InvalidResultFile, type ResultFile } from './result-file.ts';

// An epic's checkout: the main repo, the epic's branch and the linked worktree it is checked out in.
export type Worktree = { readonly repo: string; readonly branch: string; readonly path: string };

// The layout T3 makes its worktrees in: <directory>/<repo>/<branch-slug>.
export const worktreePath = (worktreesDirectory: string, repo: string, branch: string) =>
	join(worktreesDirectory, basename(repo), branch.replace(/[^A-Za-z0-9._-]+/g, '-'));

export const parseGithubRepo = (remoteUrl: string) =>
	Option.fromNullishOr(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remoteUrl)?.[1]);

const lockError = /\.lock': File exists|Unable to create '[^']*\.lock'|another git process seems to be running/;

const networkError =
	/Could not resolve host|Connection (?:timed out|refused|reset)|Operation timed out|Network is unreachable|unable to access|early EOF|remote end hung up unexpectedly|ssh: connect to host/;

const isNetworkCommand = (args: ReadonlyArray<string>) => args[0] === 'fetch' || args[0] === 'pull';

// A git lock held by another process, or a network failure while talking to the remote, is worth retrying.
export const gitFailure = (cwd: string, args: ReadonlyArray<string>, exitCode: number, stderr: string): CallError => {
	const message = `git -C ${cwd} ${args.join(' ')} failed with exit code ${exitCode}: ${stderr}`;

	return lockError.test(stderr) || (isNetworkCommand(args) && networkError.test(stderr)) ? new Transient({ message }) : new Permanent({ message });
};

const parseWorktreeList = (porcelain: string) =>
	porcelain.split('\n\n').flatMap((block) => {
		const lines = block.split('\n');
		const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
		const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);

		return path && branch ? [{ path, branch }] : [];
	});

export class Git extends Context.Service<
	Git,
	{
		readonly worktreePath: (repo: string, branch: string) => string;
		// Checks the branch out in its own worktree and returns its path.
		readonly prepareWorktree: (repo: string, branch: string) => Effect.Effect<string, CallError>;
		readonly pull: (worktree: Worktree) => Effect.Effect<void, CallError>;
		// A worktree of the repo at `path` on no branch, at origin's default branch as fetched now; made if missing.
		readonly checkoutDefaultBranch: (repo: string, path: string) => Effect.Effect<void, CallError>;
		// Commits `savedHead` contains count as on origin, e.g. those of a PR GitHub squash-merged and whose branch it
		// deleted.
		readonly unsavedWork: (worktree: Worktree, savedHead?: string) => Effect.Effect<Option.Option<string>, CallError>;
		readonly removeWorktree: (worktree: Worktree) => Effect.Effect<void, CallError>;
		readonly listWorktrees: (repo: string) => Effect.Effect<ReadonlyArray<Worktree>, CallError>;
		// The branch origin's HEAD points at, e.g. main.
		readonly defaultBranch: (repo: string) => Effect.Effect<string, CallError>;
		readonly githubRepo: (repo: string) => Effect.Effect<string, CallError>;
		readonly readResultFile: (worktree: Worktree) => Effect.Effect<Option.Option<ResultFile>, CallError | InvalidResultFile>;
		readonly removeResultFile: (worktree: Worktree) => Effect.Effect<void, CallError>;
	}
>()('sapphire-agent/Git') {
	static readonly layer = Layer.effect(
		Git,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const { worktreesDirectory } = yield* AppConfig;
			const semaphores = new Map<string, Semaphore.Semaphore>();

			// git takes lock files in the main repo for operations in any of its worktrees, so they all share one lock.
			const locked =
				(repo: string) =>
				<A, E>(operation: Effect.Effect<A, E>) =>
					Effect.suspend(() => {
						const key = resolve(repo);
						const semaphore = semaphores.get(key) ?? Semaphore.makeUnsafe(1);

						semaphores.set(key, semaphore);

						return semaphore.withPermit(operation);
					});

			const run = (cwd: string, args: ReadonlyArray<string>) => {
				const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

				return Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(ChildProcess.make('git', ['-C', cwd, ...args]));
						const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
					}),
				).pipe(Effect.mapError((error) => new Permanent({ message: `git -C ${cwd} ${args.join(' ')}: ${error.message}`, cause: error })));
			};

			const git = (cwd: string, args: ReadonlyArray<string>) =>
				run(cwd, args).pipe(
					Effect.flatMap(({ stdout, stderr, exitCode }) => (exitCode === 0 ? Effect.succeed(stdout) : Effect.fail(gitFailure(cwd, args, exitCode, stderr)))),
					withCallPolicy(callTimeouts.git),
				);

			const succeeds = (cwd: string, args: ReadonlyArray<string>) =>
				run(cwd, args).pipe(
					Effect.map(({ exitCode }) => exitCode === 0),
					withCallPolicy(callTimeouts.git),
				);

			const exists = (path: string) => fs.exists(path).pipe(Effect.mapError(fileSystemFailure));

			const branchExists = (repo: string, branch: string) => succeeds(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);

			const defaultBranch = (repo: string) => {
				const read = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);

				return read.pipe(
					Effect.catch(() => git(repo, ['remote', 'set-head', 'origin', '--auto']).pipe(Effect.andThen(read))),
					Effect.map((ref) => ref.replace(/^origin\//, '')),
				);
			};

			// The agent writes its result into the worktree's own git dir (`.git` is a file in a linked worktree), so it can
			// never be committed. The orchestrate skill resolves the same path with `git rev-parse --git-dir`.
			const resultFilePath = ({ repo, path }: Worktree) =>
				git(path, ['rev-parse', '--absolute-git-dir']).pipe(
					Effect.map((gitDir) => join(gitDir, 'sapphire-agent-result.json')),
					locked(repo),
				);

			return Git.of({
				worktreePath: (repo, branch) => worktreePath(worktreesDirectory, repo, branch),

				// Reuses the checkout from an earlier attempt. A new branch starts from the freshly fetched default branch
				// without tracking it, so a plain push never targets the default branch.
				prepareWorktree: (repo, branch) =>
					Effect.gen(function* () {
						const path = worktreePath(worktreesDirectory, repo, branch);

						yield* git(repo, ['fetch', 'origin']);

						if (yield* exists(path)) {
							const checkedOut = yield* git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);

							if (checkedOut !== branch) {
								return yield* new Permanent({ message: `${path} already exists with ${checkedOut} checked out instead of ${branch}` });
							}

							return path;
						}

						if (yield* branchExists(repo, branch)) {
							yield* git(repo, ['worktree', 'add', path, branch]);
						} else if (yield* succeeds(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
							yield* git(repo, ['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
						} else {
							yield* git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, `origin/${yield* defaultBranch(repo)}`]);
						}

						return path;
					}).pipe(locked(repo)),

				checkoutDefaultBranch: (repo, path) =>
					Effect.gen(function* () {
						yield* git(repo, ['fetch', 'origin']);

						const head = `origin/${yield* defaultBranch(repo)}`;

						yield* (yield* exists(path)) ? git(path, ['checkout', '--quiet', '--detach', head]) : git(repo, ['worktree', 'add', '--quiet', '--detach', path, head]);
					}).pipe(locked(repo)),

				// Names origin explicitly: a branch created without tracking has no upstream to pull from.
				pull: ({ repo, branch, path }) => git(path, ['pull', '--ff-only', 'origin', branch]).pipe(Effect.asVoid, locked(repo)),

				// A commit counts as pushed when any origin branch contains it, so a branch never pushed is unsaved as soon as
				// it has commits beyond the default branch.
				unsavedWork: ({ repo, branch, path }, savedHead) =>
					Effect.gen(function* () {
						const hasWorktree = yield* exists(path);

						if (hasWorktree && (yield* git(path, ['status', '--porcelain']))) {
							return Option.some('uncommitted changes');
						}

						const heads = [...(hasWorktree ? ['HEAD'] : []), ...((yield* branchExists(repo, branch)) ? [`refs/heads/${branch}`] : [])];

						if (heads.length === 0) {
							return Option.none();
						}

						// A head this clone does not have may or may not hold its commits; they count as unpushed.
						const saved = savedHead !== undefined && (yield* succeeds(repo, ['cat-file', '-e', `${savedHead}^{commit}`])) ? [savedHead] : [];
						const unpushed = Number(yield* git(hasWorktree ? path : repo, ['rev-list', '--count', ...heads, '--not', '--remotes=origin', ...saved]));

						return unpushed > 0 ? Option.some(`${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}`) : Option.none();
					}).pipe(locked(repo)),

				// Either may already be gone. Callers check unsavedWork first; `worktree remove` without --force still refuses
				// a dirty worktree.
				removeWorktree: ({ repo, branch, path }) =>
					Effect.gen(function* () {
						if (yield* exists(path)) {
							yield* git(repo, ['worktree', 'remove', path]);
						}

						// A worktree directory deleted by hand stays registered, and git refuses to delete a branch checked out there.
						yield* git(repo, ['worktree', 'prune']);

						if (yield* branchExists(repo, branch)) {
							yield* git(repo, ['branch', '--delete', '--force', branch]);
						}
					}).pipe(locked(repo)),

				// Worktrees on a detached HEAD are skipped: sapphire-agent always checks out a branch.
				listWorktrees: (repo) =>
					git(repo, ['worktree', 'list', '--porcelain']).pipe(
						Effect.map((porcelain) =>
							parseWorktreeList(porcelain)
								.filter(({ path }) => path.startsWith(worktreesDirectory + sep))
								.map(({ path, branch }) => ({ repo, branch, path })),
						),
						locked(repo),
					),

				defaultBranch: (repo) => defaultBranch(repo).pipe(locked(repo)),

				githubRepo: (repo) =>
					git(repo, ['remote', 'get-url', 'origin']).pipe(
						Effect.flatMap((remoteUrl) =>
							Option.match(parseGithubRepo(remoteUrl), {
								onNone: () => Effect.fail(new Permanent({ message: `origin ${remoteUrl} is not a GitHub repository` })),
								onSome: Effect.succeed,
							}),
						),
						locked(repo),
					),

				// None while the agent has not written the file.
				readResultFile: (worktree) =>
					Effect.gen(function* () {
						const path = yield* resultFilePath(worktree);
						const text = yield* fs.readFileString(path).pipe(
							Effect.map(Option.some),
							Effect.catchTag('PlatformError', (error) => (error.reason._tag === 'NotFound' ? Effect.succeedNone : Effect.fail(fileSystemFailure(error)))),
						);

						if (Option.isNone(text)) {
							return Option.none();
						}

						return Option.some(yield* decodeResultFile(text.value));
					}),

				// A reused worktree may still hold the result of an earlier run.
				removeResultFile: (worktree) =>
					resultFilePath(worktree).pipe(
						Effect.flatMap((path) => fs.remove(path, { force: true }).pipe(Effect.mapError(fileSystemFailure))),
					),
			});
		}),
	);
}
