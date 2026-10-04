import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Console, Context, Effect, Exit, Layer, Option, Scope } from 'effect';
import { TestConsole } from 'effect/testing';
import { ClaudeTrust } from './claude-trust.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { runCtl } from './ctl.ts';
import { GitHubAppFixture } from './github-app-fixture.ts';
import { FakeGitHub, type FakeGitHubControls } from './github-fake.ts';
import { Git } from './git.ts';
import { Herdr, type HerdrAgentStatus } from './herdr.ts';
import { FakeHerdr, type FakeHerdrControls } from './herdr-fake.ts';
import { type Command, Journal, type Run } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { type EpicSeed, LinearFixture, type LinearFixtureShape, testTeam } from './linear-fixture.ts';
import { parseMarker } from './markers.ts';
import { type Observation, Observer, type StartedRun } from './observation.ts';
import { Planner } from './planner.ts';
import { Prompts } from './prompts.ts';
import { rules } from './rules.ts';

// `<purpose>:<key>` of each marked body, in order; unmarked bodies are left out.
export const markerKeys = (bodies: ReadonlyArray<string>) =>
	bodies.flatMap((body) => Option.toArray(Option.map(parseMarker(body), (marker) => `${marker.purpose}:${marker.key}`)));

// Runs git in `cwd` with a test identity.
export const git = (cwd: string, ...args: Array<string>) =>
	execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

export type Harness = {
	// Holds the config's paths: repo, worktrees, claude.json, journal.db.
	readonly dir: string;
	// The Test team's clone, with origin a bare repo whose path ends in github.com/test/repo.git.
	readonly repo: string;
	readonly origin: string;
	// What Git.githubRepo reads from the clone's origin.
	readonly githubRepo: string;
	readonly linear: LinearFixtureShape;
	readonly github: FakeGitHubControls;
	readonly herdr: FakeHerdrControls;
	// One tick of the current planner, with every rule in production order.
	readonly tick: Effect.Effect<void>;
	readonly pausedTick: Effect.Effect<void>;
	// A process restart: the planner, its rules and the journal connection are built again on the same journal file,
	// while Linear, GitHub, herdr and the repos keep their state.
	readonly restart: Effect.Effect<void>;
	// Counted from this call: the nth journal write the reconciler makes dies without being applied, as if the process
	// crashed right before recording what it had just done.
	readonly crashAtJournalWrite: (nth: number) => void;
	// As the user renames a tab in herdr.
	readonly renameTab: (tabId: string, label: string) => Effect.Effect<void>;
	// Moves the epic in Linear as the user does.
	readonly moveEpic: (epicId: string, state: string) => void;
	// Whether the injected journal crash happened.
	readonly crashed: () => boolean;
	// Journal writes of the reconciler so far, the crashed one included.
	readonly journalWrites: () => number;
	readonly runs: Effect.Effect<ReadonlyArray<Run>>;
	readonly commands: Effect.Effect<ReadonlyArray<Command>>;
	// markerKeys of the issue's comments.
	readonly epicMarkers: (issueId: string) => ReadonlyArray<string>;
	// An epic in Implementing with a run as the start rule leaves it: a real worktree, a tab running Claude, a running
	// row claimed at the current TestClock time.
	readonly startedRun: (seed: EpicSeed & { readonly agentStatus?: HerdrAgentStatus; readonly tail?: string }) => Effect.Effect<{ readonly epic: Epic; readonly run: StartedRun }>;
	// Writes the run's result file where the agent writes it.
	readonly writeResultFile: (run: Run, contents: string) => void;
	// Paths of the worktrees git knows under the worktrees directory.
	readonly worktrees: () => ReadonlyArray<string>;
	readonly hasBranch: (branch: string) => boolean;
	// Runs `scripts/ctl.sh <args>` as a command's agent does, through its own journal connection, and returns the lines
	// it printed.
	readonly ctl: (...args: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, unknown>;
};

const makeRepos = (dir: string) => {
	const origin = join(dir, 'github.com', 'test', 'repo.git');
	const seed = join(dir, 'seed');
	const repo = join(dir, 'repo');

	mkdirSync(origin, { recursive: true });
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
	git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
	git(seed, 'push', '--quiet', origin, 'main');
	execFileSync('git', ['clone', '--quiet', origin, repo]);

	return { origin, repo };
};

// Real temp git repos, the Linear and GitHub App fixture servers, the GitHub and herdr fakes and a temp-file SQLite
// journal, wired to the production rules. Needs a Scope; everything is removed when it closes.
export const makeHarness = (settings: Parameters<typeof AppConfig.layerTest>[1] = {}) =>
	Effect.gen(function* () {
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), 'herdr-linear-harness-'))),
			(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
		);
		const { origin, repo } = makeRepos(dir);

		writeFileSync(join(dir, 'claude.json'), '{}\n');

		const config = AppConfig.layerTest(dir, settings);
		const fixtures = yield* Layer.build(
			Layer.mergeAll(LinearFixture.layer, FakeGitHub.layer.pipe(Layer.provideMerge(GitHubAppFixture.layer)), FakeHerdr.layer).pipe(Layer.provideMerge(config)),
		);
		let journalWrites = 0;
		let crashAt = Option.none<number>();
		let crashed = false;

		const crashPoint = Effect.suspend(() => {
			journalWrites += 1;

			if (Option.contains(crashAt, journalWrites)) {
				crashed = true;

				return Effect.die(new Error(`injected crash before journal write ${journalWrites}`));
			}

			return Effect.void;
		});

		const CrashingJournal = Layer.effect(
			Journal,
			Effect.gen(function* () {
				const journal = yield* Journal;

				return Journal.of({
					...journal,
					putRun: (run) => crashPoint.pipe(Effect.andThen(journal.putRun(run))),
					deleteRun: (epicId) => crashPoint.pipe(Effect.andThen(journal.deleteRun(epicId))),
					addCommand: (command) => crashPoint.pipe(Effect.andThen(journal.addCommand(command))),
					putCommand: (command) => crashPoint.pipe(Effect.andThen(journal.putCommand(command))),
					addMentionThread: (thread) => crashPoint.pipe(Effect.andThen(journal.addMentionThread(thread))),
					deleteMentionThread: (threadId) => crashPoint.pipe(Effect.andThen(journal.deleteMentionThread(threadId))),
					addRequest: (request) => crashPoint.pipe(Effect.andThen(journal.addRequest(request))),
					deleteRequest: (id) => crashPoint.pipe(Effect.andThen(journal.deleteRequest(id))),
					claimFollowUp: (run, requestId) => crashPoint.pipe(Effect.andThen(journal.claimFollowUp(run, requestId))),
				});
			}),
		).pipe(Layer.provide(Journal.layer(join(dir, 'journal.db'))));

		const stack = Planner.layer(rules).pipe(
			Layer.provide(Observer.layer),
			Layer.provideMerge(Layer.mergeAll(Git.layer, ClaudeTrust.layer, Comments.layer, Prompts.layer)),
			Layer.provideMerge(CrashingJournal),
			Layer.provide(Layer.succeedContext(fixtures)),
			Layer.provide(NodeServices.layer),
		);

		const build = Effect.gen(function* () {
			const scope = yield* Scope.make();
			const context = yield* Layer.buildWithScope(stack, scope);

			return { scope, context };
		}).pipe(Effect.orDie);

		let current = yield* build;

		yield* Effect.addFinalizer(() => Scope.close(current.scope, Exit.void));

		const services = Effect.sync(() => current.context);

		const restart = Effect.gen(function* () {
			yield* Scope.close(current.scope, Exit.void);
			current = yield* build;
		});

		const tick = (paused: boolean) => services.pipe(Effect.flatMap((context) => Context.get(context, Planner).tick({ paused })));

		const linear = Context.get(fixtures, LinearFixture);
		const herdr = Context.get(fixtures, FakeHerdr);
		const { workspaceLabel } = Context.get(fixtures, AppConfig);
		const journal = Effect.map(services, Context.get(Journal));

		const startedRun = ({ agentStatus, tail, ...seed }: EpicSeed & { readonly agentStatus?: HerdrAgentStatus; readonly tail?: string }) =>
			Effect.gen(function* () {
				const [epic] = yield* Context.get(fixtures, Linear)
					.epics([linear.addEpic({ state: 'Implementing', ...seed }).id])
					.pipe(Effect.orDie);
				const context = yield* services;
				const path = yield* Context.get(context, Git).prepareWorktree(repo, epic.branchName).pipe(Effect.orDie);
				const prompts = Context.get(context, Prompts);
				const tab = herdr.addTab({ label: prompts.tabLabel(epic), workspace: workspaceLabel, agentStatus, tail });
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				const run: StartedRun = {
					epicId: epic.id,
					identifier: epic.identifier,
					teamId: epic.team.id,
					status: 'running',
					job: { _tag: 'orchestrate' },
					repo,
					branch: epic.branchName,
					worktreePath: path,
					tabId: tab.tabId,
					paneId: tab.paneId,
					claimedAt: now,
					startedAt: now,
					agentStatus: null,
					agentStatusSince: null,
					nudgedAt: null,
					tailHash: null,
					result: null,
					questionCommentId: null,
					deliveredReplyIds: [],
				};

				yield* (yield* journal).putRun(run).pipe(Effect.orDie);

				return { epic, run };
			});

		return {
			dir,
			repo,
			origin,
			githubRepo: 'test/repo',
			linear,
			github: Context.get(fixtures, FakeGitHub),
			herdr,
			tick: tick(false),
			pausedTick: tick(true),
			restart,
			crashAtJournalWrite: (nth) => {
				crashAt = Option.some(journalWrites + nth);
				crashed = false;
			},
			crashed: () => crashed,
			journalWrites: () => journalWrites,
			renameTab: (tabId, label) => Context.get(fixtures, Herdr).renameTab(tabId, label).pipe(Effect.orDie),
			moveEpic: (epicId, state) => {
				const issue = linear.issue(epicId);
				const found = testTeam.states.nodes.find((candidate) => candidate.name === state);

				if (!found) {
					throw new Error(`no state ${state}`);
				}

				issue.stateId = found.id;
			},
			runs: journal.pipe(Effect.flatMap((found) => found.listRuns), Effect.orDie),
			commands: journal.pipe(Effect.flatMap((found) => found.listCommands), Effect.orDie),
			epicMarkers: (issueId) => markerKeys(linear.comments(issueId).map((comment) => comment.body)),
			startedRun,
			writeResultFile: (run, contents) => {
				if (run.worktreePath === null) {
					throw new Error(`${run.identifier} has no worktree`);
				}

				writeFileSync(join(git(run.worktreePath, 'rev-parse', '--absolute-git-dir'), 'herdr-result.json'), contents);
			},
			worktrees: () =>
				git(repo, 'worktree', 'list', '--porcelain')
					.split('\n')
					.filter((line) => line.startsWith('worktree ') && line !== `worktree ${repo}`)
					.map((line) => line.slice('worktree '.length)),
			hasBranch: (branch) => git(repo, 'branch', '--list', branch) !== '',
			ctl: (...args) =>
				Effect.gen(function* () {
					const output = yield* TestConsole.make;

					yield* runCtl(args).pipe(
						Effect.provideService(Console.Console, output),
						Effect.provide(Layer.mergeAll(Journal.layer(join(dir, 'journal.db')), NodeServices.layer).pipe(Layer.provideMerge(Layer.succeedContext(fixtures)))),
					);

					return (yield* output.logLines).flatMap((line) => String(line).split('\n'));
				}),
		} satisfies Harness;
	});

// Nothing observed: for planner and reconciler tests whose rules do not look at the world.
const emptyObservation: Observation = { teams: new Map(), epics: new Map(), ready: [], tabs: [], worktrees: [] };

// What Planner.layer needs besides its rules, with an observer that sees nothing and an in-memory journal.
export const plannerDependencies = (dir: string, settings: Parameters<typeof AppConfig.layerTest>[1] = {}) =>
	Layer.mergeAll(Layer.succeed(Observer, { observe: Effect.succeed(emptyObservation) }), Journal.layer(':memory:'), Comments.layer, LinearFixture.layer).pipe(
		Layer.provideMerge(AppConfig.layerTest(dir, settings)),
	);
