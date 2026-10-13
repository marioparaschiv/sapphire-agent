import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NodeServices } from '@effect/platform-node';
import { Console, Context, Effect, Exit, Layer, Option, Scope } from 'effect';
import { TestConsole } from 'effect/testing';
import { AgentActivity } from './agent-activity.ts';
import { AgentEventServer } from './agent-event-server.ts';
import { writeTranscript } from './claude-transcript-fixture.ts';
import { ClaudeTranscript, type TranscriptSession } from './claude-transcript.ts';
import { Comments } from './comments.ts';
import { AppConfig, T3Config, testSettings } from './config.ts';
import { runCtl } from './ctl.ts';
import { GitHubAppFixture, postDelivery, type WebhookDelivery } from './github-app-fixture.ts';
import { type FakeComment, FakeGitHub, type FakeGitHubControls } from './github-fake.ts';
import { Git } from './git.ts';
import { type Command, Journal, type Run } from './journal.ts';
import { type EpicSeed, type FixtureIssue, LinearFixture, type LinearFixtureShape } from './linear-fixture.ts';
import { parseMarker } from './markers.ts';
import { isThreaded, type Observation, Observer, type ThreadedRun } from './observation.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Projects } from './projects.ts';
import { Prompts } from './prompts.ts';
import { FakePushover, type FakePushoverControls } from './pushover-fake.ts';
import { Reconciler } from './reconciler.ts';
import { rules } from './rules.ts';
import { FakeT3, type FakeT3Controls } from './t3-fake.ts';
import { T3Projects } from './t3-projects.ts';
import { WebhookServer } from './webhook-server.ts';

// `<purpose>:<key>` of each marked body, in order; unmarked bodies are left out.
export const markerKeys = (bodies: ReadonlyArray<string>) =>
	bodies.flatMap((body) => Option.toArray(Option.map(parseMarker(body), (marker) => `${marker.purpose}:${marker.key}`)));

// Runs git in `cwd` with a test identity.
export const git = (cwd: string, ...args: Array<string>) =>
	execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

// The comment as GitHub's webhook payloads carry it. `id` is the node id.
const webhookComment = ({ id, url, body, author }: Pick<FakeComment, 'id' | 'url' | 'author'> & { readonly body: string | null }) => ({
	id: Number(/\d+$/.exec(id)?.[0]),
	node_id: id,
	html_url: url,
	body,
	user: { login: author, type: author.endsWith('[bot]') ? 'Bot' : 'User' },
	author_association: 'OWNER',
	created_at: '2026-10-04T09:40:00Z',
});

const webhookRepository = (repo: string) => ({ id: 1_000_001, full_name: repo, name: repo.split('/')[1], private: true, owner: { login: repo.split('/')[0] } });

const webhookPullRequest = (repo: string, number: number) => ({ number, html_url: `https://github.com/${repo}/pull/${number}`, state: 'open' });

// Deliveries as GitHub sends them for a new comment on an issue or PR, a new review comment and a submitted review.
export const deliveries = {
	issueComment: (repo: string, number: number, comment: FakeComment, action = 'created'): WebhookDelivery => ({
		event: 'issue_comment',
		payload: {
			action,
			issue: { number, html_url: `https://github.com/${repo}/pull/${number}`, pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` } },
			comment: webhookComment(comment),
			repository: webhookRepository(repo),
			sender: { login: comment.author },
			installation: { id: 1001 },
		},
	}),
	reviewComment: (repo: string, number: number, comment: FakeComment): WebhookDelivery => ({
		event: 'pull_request_review_comment',
		payload: {
			action: 'created',
			pull_request: webhookPullRequest(repo, number),
			comment: { ...webhookComment(comment), path: 'src/sync/merge.ts', line: 3 },
			repository: webhookRepository(repo),
			sender: { login: comment.author },
			installation: { id: 1001 },
		},
	}),
	review: (repo: string, number: number, review: { readonly id: string; readonly body: string | null; readonly author: string }, action = 'submitted'): WebhookDelivery => ({
		event: 'pull_request_review',
		payload: {
			action,
			pull_request: webhookPullRequest(repo, number),
			review: { ...webhookComment({ ...review, url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${/\d+$/.exec(review.id)?.[0]}` }), state: 'commented' },
			repository: webhookRepository(repo),
			sender: { login: review.author },
			installation: { id: 1001 },
		},
	}),
};

// An Issue update webhook payload, as Linear sends one when an issue moves to another state.
export const linearIssueMoved = {
	action: 'update',
	type: 'Issue',
	createdAt: '2026-10-06T07:00:00.000Z',
	data: { id: 'issue-test-12', identifier: 'TEST-12', state: { name: 'Ready For Agent' } },
	updatedFrom: { stateId: 'state-backlog' },
	url: 'https://linear.app/test/issue/TEST-12',
	webhookTimestamp: 1_791_270_000_000,
	webhookId: 'webhook-1',
};

export type Harness = {
	// Holds the config's paths: repo, worktrees, journal.db.
	readonly dir: string;
	// The Test team's clone, with origin a bare repo whose path ends in github.com/test/repo.git.
	readonly repo: string;
	readonly origin: string;
	// What Git.githubRepo reads from the clone's origin.
	readonly githubRepo: string;
	readonly linear: LinearFixtureShape;
	readonly github: FakeGitHubControls;
	// What the service sent to Pushover.
	readonly pushover: FakePushoverControls;
	readonly t3: FakeT3Controls;
	// Sends the delivery to the current webhook server, as postDelivery does with the configured secret; returns the HTTP
	// status.
	readonly deliver: (delivery: WebhookDelivery, signature?: string | null) => Effect.Effect<number>;
	// One tick of the current planner, with every rule in production order.
	readonly tick: Effect.Effect<void>;
	readonly pausedTick: Effect.Effect<void>;
	// A process restart: the planner, its rules, the webhook server and the journal connection are built again on the
	// same journal file, while Linear, GitHub, T3 and the repos keep their state.
	readonly restart: Effect.Effect<void>;
	// The first half of a restart: the service is down.
	readonly stop: Effect.Effect<void>;
	// Counted from this call: the nth journal write the reconciler or the webhook server makes dies
	// without being applied, as if the process crashed right before recording what it had just done.
	readonly crashAtJournalWrite: (nth: number) => void;
	// Moves the epic, or an issue of another team, in Linear as the user does.
	readonly moveEpic: (epicId: string, state: string) => void;
	// Whether the injected journal crash happened.
	readonly crashed: () => boolean;
	// Journal writes of the reconciler so far, the crashed one included.
	readonly journalWrites: () => number;
	readonly runs: Effect.Effect<ReadonlyArray<Run>>;
	readonly commands: Effect.Effect<ReadonlyArray<Command>>;
	// markerKeys of the issue's comments.
	readonly epicMarkers: (issueId: string) => ReadonlyArray<string>;
	// The notices written for the epic, oldest first, with `<purpose>:<key>` and whether they were posted.
	readonly notices: (identifier: string) => ReadonlyArray<JournalNotice>;
	// The worktree T3 makes for a thread launched on a new one: the epic's branch from origin's default branch.
	readonly makeT3Worktree: (branch: string) => string;
	// A ready epic dispatched as the reconciler does, its thread's worktree made by T3 and recorded.
	readonly threadRun: (seed: EpicSeed) => Effect.Effect<{ readonly epic: FixtureIssue; readonly run: ThreadedRun }>;
	// Writes the run's result file where the agent writes it.
	readonly writeResultFile: (run: Run, contents: string) => void;
	// Writes the Claude session's transcript where Claude Code writes it.
	readonly writeTranscript: (session: TranscriptSession, entries: ReadonlyArray<Record<string, unknown>>) => void;
	// Writes the transcript of the session's subagent `agentId` where Claude Code writes it, and returns its path.
	readonly writeSubagentTranscript: (session: TranscriptSession, agentId: string, entries: ReadonlyArray<Record<string, unknown>>) => string;
	// Paths of the worktrees git knows under the worktrees directory.
	readonly worktrees: () => ReadonlyArray<string>;
	readonly hasBranch: (branch: string) => boolean;
	// Runs `scripts/ctl.sh <args>` as a command's agent does, through its own journal connection, and returns the lines
	// it printed.
	readonly ctl: (...args: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, unknown>;
	// Runs `scripts/ctl.sh hook <agent>` as an agent's hook does, with the payload on stdin; returns its exit code,
	// stdout and stderr once the service answered.
	readonly hook: (agent: string, payload: string) => Effect.Effect<HookOutcome>;
};

type JournalNotice = { readonly marker: string; readonly text: string; readonly sent: boolean };

type HookOutcome = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

const ctlScript = join(import.meta.dirname, '..', 'scripts', 'ctl.sh');

const runHook = (stateDirectory: string, agent: string, payload: string) =>
	Effect.callback<HookOutcome>((resume) => {
		const child = spawn('sh', [ctlScript, 'hook', agent], {
			env: { ...process.env, SAPPHIRE_AGENT_CONFIG_DIR: stateDirectory, SAPPHIRE_AGENT_STATE_DIR: stateDirectory },
		});
		let stdout = '';
		let stderr = '';

		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('close', (code) => resume(Effect.succeed({ code, stdout, stderr })));
		child.stdin.end(payload);
	});

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

// Real temp git repos, the Linear and GitHub App fixture servers, the GitHub and T3 fakes and a temp-file SQLite
// journal, wired to the production rules and the webhook server. Needs a Scope; everything is removed when it closes.
export const makeHarness = (settings: Parameters<typeof AppConfig.layerTest>[1] = {}) =>
	Effect.gen(function* () {
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), 'sapphire-agent-harness-'))),
			(created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
		);
		const { origin, repo } = makeRepos(dir);
		const t3SettingsFile = join(dir, 't3-settings.json');

		writeFileSync(join(dir, 'config.json'), JSON.stringify(testSettings(dir, settings)));
		copyFileSync(join(import.meta.dirname, 'fixtures/t3/settings.json'), t3SettingsFile);

		const config = AppConfig.layerTest(dir, settings);
		const fixtures = yield* Layer.build(
			Layer.mergeAll(LinearFixture.layer, FakeGitHub.layer.pipe(Layer.provideMerge(GitHubAppFixture.layer)), FakePushover.layer, FakeT3.layer(t3SettingsFile)).pipe(Layer.provideMerge(config)),
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
					addRequest: (request) => crashPoint.pipe(Effect.andThen(journal.addRequest(request))),
					deleteRequest: (id) => crashPoint.pipe(Effect.andThen(journal.deleteRequest(id))),
					claimRun: (run, requestIds) => crashPoint.pipe(Effect.andThen(journal.claimRun(run, requestIds))),
					addNotice: (notice) => crashPoint.pipe(Effect.andThen(journal.addNotice(notice))),
					addSubagentHandoff: (handoff) => crashPoint.pipe(Effect.andThen(journal.addSubagentHandoff(handoff))),
					markNoticeSent: (id) => crashPoint.pipe(Effect.andThen(journal.markNoticeSent(id))),
				});
			}),
		).pipe(Layer.provide(Journal.layer(join(dir, 'journal.db'))));

		const stack = Layer.mergeAll(WebhookServer.layer, AgentEventServer.layer).pipe(
			Layer.provideMerge(Reconciler.layer.pipe(Layer.provide(Pause.layer))),
			Layer.provideMerge(Planner.layer(rules).pipe(Layer.provide(Observer.layer))),
			Layer.provideMerge(Layer.mergeAll(Git.layer, ClaudeTranscript.layer, Comments.layer, Prompts.layer)),
			Layer.provideMerge(Layer.mergeAll(Projects.layer, T3Projects.layer, AgentActivity.layer)),
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

		const stop = Effect.suspend(() => Scope.close(current.scope, Exit.void));

		const restart = Effect.gen(function* () {
			yield* stop;
			current = yield* build;
		});

		const tick = (paused: boolean) => services.pipe(Effect.flatMap((context) => Context.get(context, Planner).tick({ paused })));

		const linear = Context.get(fixtures, LinearFixture);
		const { webhookSecret } = Context.get(fixtures, AppConfig);
		const journal = Effect.map(services, Context.get(Journal));

		const makeT3Worktree = (branch: string) => {
			const path = join(dir, 'worktrees', 'repo', branch.replace(/[^A-Za-z0-9._-]+/g, '-'));

			git(repo, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, 'origin/main');

			return path;
		};

		const threadRun = (seed: EpicSeed) =>
			Effect.gen(function* () {
				const epic = linear.addEpic(seed);

				yield* tick(false);

				const claimed = yield* journal.pipe(Effect.flatMap((found) => found.getRun(epic.id)), Effect.orDie);

				if (Option.isNone(claimed) || claimed.value.threadId === null) {
					return yield* Effect.die(new Error(`${seed.identifier} was not dispatched to T3`));
				}

				yield* Context.get(fixtures, FakeT3).setWorktreePath(claimed.value.threadId, makeT3Worktree(claimed.value.branch));
				yield* tick(false);

				const run = Option.filter(yield* journal.pipe(Effect.flatMap((found) => found.getRun(epic.id)), Effect.orDie), isThreaded);

				return Option.isSome(run) ? { epic, run: run.value } : yield* Effect.die(new Error(`${seed.identifier} has no worktree recorded`));
			});

		return {
			dir,
			repo,
			origin,
			githubRepo: 'test/repo',
			linear,
			github: Context.get(fixtures, FakeGitHub),
			pushover: Context.get(fixtures, FakePushover),
			t3: Context.get(fixtures, FakeT3),
			deliver: (delivery: WebhookDelivery, signature?: string | null) => services.pipe(Effect.flatMap((context) => postDelivery(Context.get(context, WebhookServer).url, webhookSecret, delivery, signature))),
			tick: tick(false),
			pausedTick: tick(true),
			restart,
			stop,
			crashAtJournalWrite: (nth) => {
				crashAt = Option.some(journalWrites + nth);
				crashed = false;
			},
			crashed: () => crashed,
			journalWrites: () => journalWrites,
			moveEpic: (epicId, state) => linear.moveIssue(epicId, state),
			runs: journal.pipe(Effect.flatMap((found) => found.listRuns), Effect.orDie),
			commands: journal.pipe(Effect.flatMap((found) => found.listCommands), Effect.orDie),
			epicMarkers: (issueId) => markerKeys(linear.comments(issueId).map((comment) => comment.body)),
			notices: (identifier) => {
				const database = new DatabaseSync(join(dir, 'journal.db'), { readOnly: true });
				const rows = database.prepare('SELECT purpose, key, text, sent_at FROM notices WHERE identifier = ? ORDER BY id').all(identifier);

				database.close();

				return rows.map(({ purpose, key, text, sent_at }) => ({ marker: `${String(purpose)}:${String(key)}`, text: String(text), sent: sent_at !== null }));
			},
			makeT3Worktree,
			threadRun,
			writeResultFile: (run, contents) => {
				if (run.worktreePath === null) {
					throw new Error(`${run.identifier} has no worktree`);
				}

				writeFileSync(join(git(run.worktreePath, 'rev-parse', '--absolute-git-dir'), 'sapphire-agent-result.json'), contents);
			},
			writeTranscript: (session, entries) => {
				writeTranscript(Context.get(fixtures, AppConfig).env.claudeConfigDirectory, session, entries);
			},
			writeSubagentTranscript: (session, agentId, entries) => writeTranscript(Context.get(fixtures, AppConfig).env.claudeConfigDirectory, session, entries, agentId),
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
						Effect.provide(
								Layer.mergeAll(T3Projects.layer.pipe(Layer.provideMerge(Journal.layer(join(dir, 'journal.db')))), Git.layer, Pause.layer, T3Config.layerTest(t3SettingsFile)).pipe(
									Layer.provideMerge(NodeServices.layer),
									Layer.provideMerge(Layer.succeedContext(fixtures)),
								),
							),
					);

					return (yield* output.logLines).flatMap((line) => String(line).split('\n'));
				}),
			hook: (agent, payload) => runHook(dir, agent, payload),
		} satisfies Harness;
	});

// Nothing observed: for planner and reconciler tests whose rules do not look at the world.
export const emptyObservation: Observation = { teams: new Map(), epics: new Map(), ready: [], worktrees: [], threads: new Map() };

// What Planner.layer needs besides its rules, with an observer that sees nothing and an in-memory journal.
export const plannerDependencies = (dir: string, settings: Parameters<typeof AppConfig.layerTest>[1] = {}) =>
	Layer.mergeAll(Layer.succeed(Observer, { observe: Effect.succeed(emptyObservation) }), Journal.layer(':memory:'), Comments.layer, LinearFixture.layer, FakePushover.layer, FakeT3.layer()).pipe(
		Layer.provideMerge(AppConfig.layerTest(dir, settings)),
	);
