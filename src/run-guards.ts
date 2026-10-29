import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { commandsDirectory, ctlPath } from './directories.ts';
import type { Project } from './journal.ts';
import { hasSubstitution, isRedirection, shellWords, simpleCommands } from './shell-words.ts';

// What the guards refuse in a dispatched run, decided from the hook payload, the config, the journal's projects and git
// alone, so they hold while the service is down. Every other session is left alone.

// A dispatched run's checkout: T3 creates it at `<worktreesDirectory>/<repo>/<branch slug>` for a project's repo.
export type DispatchedRun = { readonly worktree: string; readonly repoName: string };

// A tool call as the guards see it, whichever agent makes it, with the agent's own name for the tool: a shell command,
// a file write, a tool that only reads, or anything else.
export type ToolCall =
	| { readonly _tag: 'Shell'; readonly name: string; readonly command: string }
	| { readonly _tag: 'FileWrite'; readonly name: string; readonly path: string }
	| { readonly _tag: 'Read'; readonly name: string }
	| { readonly _tag: 'Other'; readonly name: string };

// Whether a guard lets the tool call run, and why.
export type ToolDecision = { readonly allow: boolean; readonly reason: string };

// The checkout under the worktrees directory that `cwd` is in, whichever repo it belongs to.
export const worktreeOf = (worktreesDirectory: string, cwd: string): DispatchedRun | undefined => {
	const inside = relative(worktreesDirectory, resolve(cwd));

	if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
		return undefined;
	}

	const [repoName = '', slug] = inside.split(sep);

	return slug === undefined ? undefined : { worktree: join(worktreesDirectory, repoName, slug), repoName };
};

// A project's repo, or a directory under a project's label repos directory.
export const isProjectRepo = (projects: ReadonlyArray<Project>, name: string) =>
	projects.some(({ repo, labelReposDirectory }) => basename(repo) === name || (labelReposDirectory !== null && existsSync(join(labelReposDirectory, name))));

// Env files and private keys, by file name.
const isSecretFile = (path: string) => {
	const name = basename(path);

	return name.startsWith('.env') || /\.(?:pem|key|p12|pfx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name);
};

// The output of git in `dir`, or null when git fails there (not a repo, no such ref).
const gitOutput = (dir: string, args: ReadonlyArray<string>) => {
	try {
		return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
	} catch {
		return null;
	}
};

export const currentBranch = (dir: string) => gitOutput(dir, ['symbolic-ref', '--short', 'HEAD']);

type ChangedFile = { readonly path: string; readonly staged: boolean; readonly tracked: boolean };

// Every changed or untracked file git does not ignore, and with `ignored` the ignored ones too, by absolute path.
const changedFiles = (dir: string, { ignored = false }: { readonly ignored?: boolean } = {}): ReadonlyArray<ChangedFile> => {
	const root = gitOutput(dir, ['rev-parse', '--show-toplevel']);
	const status = root === null ? null : gitOutput(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored=matching'] : [])]);

	if (root === null || status === null) {
		return [];
	}

	const entries = status.split('\0');
	const files: Array<ChangedFile> = [];

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index] ?? '';

		if (entry.length < 4) {
			continue;
		}

		const [x = ' ', , , ...path] = entry;

		files.push({ path: join(root, path.join('')), staged: x !== ' ' && x !== '?' && x !== '!', tracked: x !== '?' && x !== '!' });

		// A rename or copy is followed by the path it came from.
		if (x === 'R' || x === 'C') {
			index++;
		}
	}

	return files;
};

// Whether a pathspec given in `dir` covers `file`. A glob covers everything in the directory before its first wildcard,
// a magic pathspec (`:/`) the whole repo.
const covers = (dir: string, root: string, pathspec: string, file: string) => {
	const wildcard = pathspec.search(/[*?[]/);
	const base = pathspec.startsWith(':') ? root : resolve(dir, wildcard === -1 ? pathspec : pathspec.slice(0, pathspec.lastIndexOf('/', wildcard) + 1));

	return file === base || file.startsWith(base + sep);
};

const relativeTo = (dir: string, file: string) => relative(dir, file) || '.';

type Options = { readonly flags: ReadonlySet<string>; readonly positionals: ReadonlyArray<string> };

// Splits a subcommand's arguments into flags (`-a`, `--all`, short clusters spelled out) and positionals.
// `withValue` lists the options that take the next argument when it is not attached. git takes any unambiguous prefix
// of a long option, so a long flag that is not in `known` counts as every known option it is a prefix of.
const parseOptions = (args: ReadonlyArray<string>, withValue: ReadonlySet<string>, known: ReadonlyArray<string>): Options => {
	const flags = new Set<string>();
	const positionals: Array<string> = [];
	const longOptions = [...known, ...withValue].filter((option) => option.startsWith('--'));

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? '';

		if (arg === '--') {
			positionals.push(...args.slice(index + 1));

			break;
		}

		if (arg.startsWith('--')) {
			const [typed = arg] = arg.split('=', 1);
			const expanded = longOptions.includes(typed) ? [typed] : longOptions.filter((option) => option.startsWith(typed));
			const names = expanded.length === 0 ? [typed] : expanded;

			for (const name of names) {
				flags.add(name);
			}

			if (!arg.includes('=') && names.some((name) => withValue.has(name))) {
				index++;
			}

			continue;
		}

		if (arg.startsWith('-') && arg.length > 1) {
			for (const [position, letter] of [...arg.slice(1)].entries()) {
				flags.add(`-${letter}`);

				if (withValue.has(`-${letter}`)) {
					if (position === arg.length - 2) {
						index++;
					}

					break;
				}
			}

			continue;
		}

		positionals.push(arg);
	}

	return { flags, positionals };
};

const hasAny = (flags: ReadonlySet<string>, names: ReadonlyArray<string>) => names.some((name) => flags.has(name));

const forcePush = 'force pushes are not allowed in a dispatched run: they rewrite what is on the remote';

const forceFlags = ['--force', '-f', '--force-with-lease', '--force-if-includes'];

const everyBranchFlags = ['--all', '--branches', '--mirror'];

const pushRefusal = (dir: string, args: ReadonlyArray<string>) => {
	const { flags, positionals } = parseOptions(args, new Set(['--repo', '--push-option', '-o', '--receive-pack', '--exec']), [...forceFlags, ...everyBranchFlags]);

	if (hasAny(flags, forceFlags)) {
		return forcePush;
	}

	const refspecs = flags.has('--repo') ? positionals : positionals.slice(1);

	if (hasAny(flags, everyBranchFlags) || refspecs.some((refspec) => refspec.includes('*'))) {
		return 'pushing every branch is not allowed in a dispatched run: it includes the default branch';
	}

	if (refspecs.some((refspec) => refspec.startsWith('+'))) {
		return forcePush;
	}

	const remoteHead = gitOutput(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);

	if (remoteHead === null) {
		return `cannot tell the default branch of ${dir} (origin/HEAD is not set), so no push is allowed; run \`git remote set-head origin --auto\``;
	}

	const defaultBranch = remoteHead.replace(/^origin\//, '');
	const current = currentBranch(dir);
	const destination = (refspec: string) => {
		const target = refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
		const branch = target.replace(/^refs\/heads\//, '');

		return branch === 'HEAD' || branch === '@' ? current : branch;
	};
	const destinations = refspecs.length === 0 ? [current] : refspecs.map(destination);

	return destinations.includes(defaultBranch)
		? `pushing to ${defaultBranch}, the default branch, is not allowed in a dispatched run: push the epic branch and open a pull request`
		: undefined;
};

const secretsRefusal = (dir: string, files: ReadonlyArray<string>, action: string) =>
	files.length === 0
		? undefined
		: `${action} would include ${files.map((file) => relativeTo(dir, file)).join(', ')}, which may hold secrets; env files and keys are never committed in a dispatched run`;

const addRefusal = (dir: string, args: ReadonlyArray<string>) => {
	const { flags, positionals } = parseOptions(args, new Set(['--chmod', '--pathspec-from-file']), ['-A', '--all', '--no-ignore-removal', '-u', '--update', '-f', '--force']);
	const named = positionals.filter(isSecretFile).map((pathspec) => resolve(dir, pathspec));

	if (named.length > 0) {
		return secretsRefusal(dir, named, 'git add');
	}

	const all = hasAny(flags, ['-A', '--all', '--no-ignore-removal']);
	const update = hasAny(flags, ['-u', '--update']);

	if (positionals.length === 0 && !all && !update) {
		return undefined;
	}

	const root = gitOutput(dir, ['rev-parse', '--show-toplevel']) ?? dir;
	const pathspecs = positionals.length === 0 ? [':/'] : positionals;
	const added = changedFiles(dir, { ignored: hasAny(flags, ['-f', '--force']) })
		.filter(({ path, tracked }) => isSecretFile(path) && (tracked || !update) && pathspecs.some((pathspec) => covers(dir, root, pathspec, path)))
		.map(({ path }) => path);

	return secretsRefusal(dir, added, 'git add');
};

const commitRefusal = (dir: string, args: ReadonlyArray<string>) => {
	const { flags, positionals } = parseOptions(
		args,
		new Set([
			'-m',
			'-F',
			'-C',
			'-c',
			'-t',
			'--message',
			'--file',
			'--reuse-message',
			'--reedit-message',
			'--template',
			'--author',
			'--date',
			'--fixup',
			'--squash',
			'--cleanup',
			'--trailer',
			'--pathspec-from-file',
		]),
		['-a', '--all'],
	);
	const named = positionals.filter(isSecretFile).map((pathspec) => resolve(dir, pathspec));

	if (named.length > 0) {
		return secretsRefusal(dir, named, 'git commit');
	}

	const root = gitOutput(dir, ['rev-parse', '--show-toplevel']) ?? dir;
	const all = hasAny(flags, ['-a', '--all']);
	const committed = changedFiles(dir)
		.filter(
			({ path, staged, tracked }) =>
				isSecretFile(path) && (staged || (tracked && (all || positionals.some((pathspec) => covers(dir, root, pathspec, path))))),
		)
		.map(({ path }) => path);

	return secretsRefusal(dir, committed, 'git commit');
};

const wrappers = new Set(['env', 'command', 'exec', 'time', 'nohup']);

// Options of the wrappers that take the next word: `env -C <dir>`, `env -u <name>`, `time -o <file>`, `time -f <format>`.
const wrapperWithValue = new Set(['-C', '--chdir', '-u', '--unset', '-o', '--output', '-f', '--format']);

type Unwrapped = { readonly words: ReadonlyArray<string>; readonly chdir: string | undefined; readonly setsRepo: boolean };

// The command a simple command runs, past its env assignments and wrappers like `env`; where `env -C` runs it, and
// whether an assignment points git at another repository. `env -S '<command>'` is split into its words.
const unwrap = (simple: ReadonlyArray<string>): Unwrapped => {
	const words = [...simple];
	let chdir: string | undefined;
	let setsRepo = false;
	let index = 0;

	while (index < words.length) {
		const word = words[index] ?? '';

		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			setsRepo ||= /^GIT_(?:DIR|WORK_TREE)=/.test(word);
			index++;
		} else if (word === '-S' || word === '--split-string') {
			words.splice(index, 2, ...(words[index + 1] ?? '').split(/\s+/).filter((part) => part !== ''));
		} else if (word === '-C' || word === '--chdir') {
			chdir = words[index + 1];
			index += 2;
		} else if (wrapperWithValue.has(word)) {
			index += 2;
		} else if (wrappers.has(word) || (index > 0 && word.startsWith('-'))) {
			index++;
		} else {
			break;
		}
	}

	return { words: words.slice(index), chdir, setsRepo };
};

const gitWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

const otherRepo = 'git push, add and commit with `--git-dir`, `--work-tree`, GIT_DIR or GIT_WORK_TREE are not allowed in a dispatched run: the guard cannot tell which repository they act on';

const gitRefusal = (dir: string, args: ReadonlyArray<string>, setsRepo: boolean) => {
	let target = dir;
	let repoOption = setsRepo;
	let index = 0;

	while (index < args.length && args[index]?.startsWith('-')) {
		const option = args[index] ?? '';

		if (option === '-C') {
			target = resolve(target, args[index + 1] ?? '.');
		}

		repoOption ||= /^--(?:git-dir|work-tree)(?:=|$)/.test(option);
		index += gitWithValue.has(option) ? 2 : 1;
	}

	const [subcommand, ...rest] = args.slice(index);

	if (repoOption && (subcommand === 'push' || subcommand === 'add' || subcommand === 'commit')) {
		return otherRepo;
	}

	switch (subcommand) {
		case 'push':
			return pushRefusal(target, rest);
		case 'add':
			return addRefusal(target, rest);
		case 'commit':
			return commitRefusal(target, rest);
		default:
			return undefined;
	}
};

// Why the Bash command is refused in a dispatched run, if it is: a push to the default branch, a force push, or
// staging or committing env files or keys. `cd` and `pushd` in the command move where later git commands run.
export const bashRefusal = (cwd: string, command: string) => {
	let dir = cwd;

	for (const simple of simpleCommands(command)) {
		const { words, chdir, setsRepo } = unwrap(simple);
		const [program = '', ...args] = words;

		if (program === 'cd' || program === 'pushd') {
			dir = resolve(dir, args[0] === undefined || args[0] === '~' ? homedir() : args[0].replace(/^~(?=\/)/, homedir()));

			continue;
		}

		if (basename(program) !== 'git') {
			continue;
		}

		const refusal = gitRefusal(chdir === undefined ? dir : resolve(dir, chdir), args, setsRepo);

		if (refusal !== undefined) {
			return refusal;
		}
	}

	return undefined;
};

const isInside = (dir: string, target: string) => target === dir || target.startsWith(dir + sep);

// Where a run's scratch goes besides its worktree: the temp directory (handoff docs, briefs, swarm dirs) and ~/share,
// which the user opens over the tailnet.
const scratchDirectories = () => [tmpdir(), join(homedir(), 'share')];

// Why writing `path` is refused in a dispatched run, if it is: outside the run's worktree and the scratch directories,
// inside `checkouts` (where other runs' worktrees and the project repos live, even within a scratch directory) but
// outside the run's worktree, or an env file or key.
export const fileWriteRefusal = (run: DispatchedRun, cwd: string, path: string, checkouts: ReadonlyArray<string> = []) => {
	const target = resolve(cwd, path);
	const scratch = scratchDirectories().some((dir) => isInside(dir, target)) && !checkouts.some((dir) => isInside(dir, target));

	if (!isInside(run.worktree, target) && !scratch) {
		return `${target} is outside this run's worktree ${run.worktree}; a dispatched run only writes inside its worktree, ${tmpdir()} and ~/share`;
	}

	if (isSecretFile(target)) {
		return `${basename(target)} may hold secrets; a dispatched run never writes env files or keys (reading them is fine)`;
	}

	return undefined;
};

// Why the run's agent's or a subagent's tool call is refused in a dispatched run, if it is.
export const toolRefusal = (run: DispatchedRun, cwd: string, call: ToolCall, checkouts: ReadonlyArray<string> = []) => {
	switch (call._tag) {
		case 'Shell':
			return bashRefusal(cwd, call.command);
		case 'FileWrite':
			return fileWriteRefusal(run, cwd, call.path, checkouts);
		default:
			return undefined;
	}
};

// Read-only gh and git subcommands a command's agent may run, besides the CLI. `--output` would make git write a file.
const readOnlyCommands = ['gh pr view', 'gh pr diff', 'gh pr checks', 'gh issue view', 'git log', 'git show', 'git diff', 'git status'];

// Nothing but command threads runs in the commands directory, so the hook tells a command thread by its cwd alone.
export const isCommandCwd = (stateDirectory: string, cwd: string) => {
	const inside = relative(commandsDirectory(stateDirectory), resolve(cwd));

	return !inside.startsWith('..') && !isAbsolute(inside);
};

const isAllowedCommand = (words: ReadonlyArray<string>) => {
	const [program, ...args] = words;

	if (program === 'sh' && args[0] === ctlPath) {
		return true;
	}

	return readOnlyCommands.some((allowed) => allowed.split(' ').every((word, index) => words[index] === word)) && !(program === 'git' && args.some((arg) => arg.startsWith('--output')));
};

// What a command thread's tool call may do: the read tools, the CLI, the read-only gh and git subcommands and nothing
// that writes. Allowed calls run without asking, which the supervised thread would otherwise do; every other shell
// command and every other tool is refused.
export const commandToolDecision = (call: ToolCall): ToolDecision => {
	if (call._tag === 'Read') {
		return { allow: true, reason: `a command agent may use ${call.name}` };
	}

	if (call._tag !== 'Shell') {
		return { allow: false, reason: `a command agent only reads: ${call.name} is not allowed` };
	}

	const { command } = call;

	if (hasSubstitution(command)) {
		return { allow: false, reason: 'a command agent only reads: command substitutions are not allowed' };
	}

	const commands = shellWords(command);

	if (commands.some((words) => words.some((word) => isRedirection(word) && !/^\d*>&\d+$/.test(word.text)))) {
		return { allow: false, reason: 'a command agent only reads: redirections are not allowed' };
	}

	const refused = commands.map((words) => words.map(({ text }) => text)).find((words) => !isAllowedCommand(words));

	return refused === undefined
		? { allow: true, reason: 'a read-only command of the command agent' }
		: { allow: false, reason: `a command agent only runs \`sh ${ctlPath} ...\` and ${readOnlyCommands.join(', ')}: \`${refused.join(' ')}\` is not allowed` };
};
