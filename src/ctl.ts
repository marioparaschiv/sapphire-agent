import { basename, dirname, join, resolve } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { AppConfig, T3Config, toPath } from './config.ts';
import { Git } from './git.ts';
import { type Command as CommandRow, commandIdentifier, Journal, journalPath, type Project, type Request, type Run } from './journal.ts';
import { Linear } from './linear.ts';
import { acceptsMessages, hasRunInFlight, heldBy, holdsSlot, isInFlight, isOver, resolveTeams } from './observation.ts';
import { Pause } from './pause.ts';
import { wakeFileName } from './reconciler.ts';
import { T3 } from './t3.ts';
import { T3Projects } from './t3-projects.ts';

// What the CLI refuses, said to whoever ran it: a person, or a command's agent.
export class Refused extends Schema.TaggedError<Refused>()('Refused', { message: Schema.String }) {}

const describeRun = (run: Run, epicState: string) =>
	[
		`${run.identifier} ${run.status} (${run.job._tag})`,
		...(isInFlight(run) && !holdsSlot(run) ? ['holds no slot'] : []),
		epicState,
		`claimed ${new Date(run.claimedAt).toISOString()}`,
		run.threadId === null ? 'no T3 thread' : `T3 thread ${run.threadId}`,
		run.session === null ? 'no session' : `session ${run.session.name}`,
		...(run.replyTo === null ? [] : [`reply-to ${run.replyTo}`]),
		run.worktreePath ?? 'no worktree',
	].join(', ');

const describeProject = ({ team, repo, labelReposDirectory }: Project) =>
	`project ${team}: ${repo}${labelReposDirectory === null ? '' : `, label repos in ${labelReposDirectory}`}`;

const describeProjects = (projects: ReadonlyArray<Project>) => (projects.length === 0 ? 'no projects' : projects.map(describeProject).join('\n'));

const describeCommand = (command: CommandRow) => `${commandIdentifier(command)} ${command.status}, @${command.author} in ${command.url}`;

const describeRequest = (request: Request) => {
	switch (request._tag) {
		case 'start':
			return `dispatch ${request.identifier}${request.replyTo === null ? '' : ` reply-to ${request.replyTo}`}`;
		case 'stop':
			return `stop ${request.identifier}`;
		case 'send':
			return `send ${request.identifier}: ${request.text}`;
		case 'follow-up':
			return `follow-up ${request.identifier}${request.threadIds.length > 0 ? ` threads ${request.threadIds.join(' ')}` : ''}${request.instruction === null ? '' : `: ${request.instruction}`}`;
		case 'reply':
			return `reply for CMD-${request.commandId}`;
		case 'done':
			return `done CMD-${request.commandId}`;
		case 'session':
			return `session ${request.identifier}: ${request.sessionId}`;
		case 'handoff':
			return `handoff ${request.identifier}: ${request.sessionId}`;
		case 'project-add':
			return `add project ${request.project.team}`;
		case 'project-edit':
			return `edit project ${request.project.team}`;
		case 'project-remove':
			return `remove project ${request.team}`;
	}
};

// The service ticks as soon as this file is written, instead of at the next poll.
const wake = Effect.gen(function* () {
	const { env } = yield* AppConfig;

	yield* (yield* FileSystem.FileSystem).writeFileString(join(env.stateDirectory, wakeFileName), '');
});

// The CLI only appends requests to the journal; the service acts on them.
const record = (request: Request, said: string) =>
	Journal.use((journal) => journal.addRequest(request)).pipe(Effect.andThen(wake), Effect.andThen(Console.log(said)));

const runOf = (identifier: string) =>
	Journal.use((journal) => journal.listRuns).pipe(Effect.map((runs) => Option.fromUndefinedOr(runs.find((run) => run.identifier === identifier.toUpperCase()))));

const projectOf = (team: string) =>
	Journal.use((journal) => journal.listProjects).pipe(Effect.map((projects) => Option.fromUndefinedOr(projects.find((project) => project.team === team))));

const linearTeam = (name: string) => Linear.use((linear) => linear.teams([name])).pipe(Effect.map((teams) => Option.fromUndefinedOr(teams.find((team) => team.name === name))));

const epicArgument = Argument.String('epic').pipe(
	Argument.withDescription('An epic identifier, e.g. HL-12'),
	Argument.map((identifier) => identifier.toUpperCase()),
);

const words = (name: string, description: string) =>
	Argument.String(name).pipe(Argument.withDescription(description), Argument.variadic({ min: 1 }), Argument.map((parts) => parts.join(' ')));

// The projects' ready epics that issues blocking them hold back, with those issues.
const heldEpics = (projects: ReadonlyArray<Project>) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
		const linear = yield* Linear;
		const teams = yield* resolveTeams(config, projects, yield* linear.teams(projects.map(({ team }) => team)), () => Effect.void);
		const ready = yield* linear.readyEpics([...teams.values()].map(({ stateIds }) => stateIds.ready));

		return ready.flatMap((epic) => {
			const blockers = heldBy(epic);

			return blockers.length === 0 ? [] : [`${epic.identifier} held by ${blockers.join(', ')}`];
		});
	});

const status = Command.make('status', {}, () =>
	Effect.gen(function* () {
		const journal = yield* Journal;
		const linear = yield* Linear;
		const paused = yield* Pause.use((pause) => pause.isPaused);
		const runs = yield* journal.listRuns;
		const projects = yield* journal.listProjects;
		const [epics, held] = yield* Effect.all([linear.epics(runs.map((run) => run.epicId)).pipe(Effect.result), heldEpics(projects).pipe(Effect.result)], { concurrency: 'unbounded' });
		const stateOf = (run: Run) =>
			epics._tag === 'Failure'
				? 'epic state unknown'
				: Option.match(Option.fromUndefinedOr(epics.success.find((epic) => epic.id === run.epicId)), { onNone: () => 'epic gone', onSome: (epic) => `epic in ${epic.state.name}` });
		const commands = (yield* journal.listCommands).filter((command) => command.status === 'queued' || command.status === 'claimed' || command.status === 'running');
		const requests = yield* journal.listRequests;

		yield* Console.log(`dispatching: ${paused ? 'paused' : 'active'}`);
		yield* Console.log(describeProjects(projects));
		yield* Console.log(runs.length === 0 ? 'no runs' : runs.map((run) => describeRun(run, stateOf(run))).join('\n'));

		if (epics._tag === 'Failure') {
			yield* Console.log(`cannot read the epics from Linear: ${epics.failure.message}`);
		}

		if (held._tag === 'Failure') {
			yield* Console.log(`cannot read the held epics from Linear: ${held.failure.message}`);
		} else if (held.success.length > 0) {
			yield* Console.log(held.success.join('\n'));
		}

		yield* Console.log(commands.length === 0 ? 'no commands' : commands.map(describeCommand).join('\n'));

		if (requests.length > 0) {
			yield* Console.log(requests.map(({ id, request }) => `request ${id}: ${describeRequest(request)}`).join('\n'));
		}
	}),
).pipe(Command.withDescription('Whether dispatching is paused, the projects, the runs with their epics, the ready epics held by issues blocking them, the commands in flight and the requests not acted on yet'));

const pause = Command.make('pause', {}, () =>
	Effect.gen(function* () {
		yield* Pause.use((file) => file.pause);
		yield* wake;
		yield* Console.log('dispatching paused; runs in flight are still watched');
	}),
).pipe(Command.withDescription('Starts no new runs until resume; runs in flight are still watched'));

const resume = Command.make('resume', {}, () =>
	Effect.gen(function* () {
		yield* Pause.use((file) => file.resume);
		yield* wake;
		yield* Console.log('dispatching resumed');
	}),
).pipe(Command.withDescription('Starts new runs again'));

const dispatch = Command.make(
	'dispatch',
	{
		epic: epicArgument,
		replyTo: Flag.String('reply-to').pipe(
			Flag.withDescription('The Claude session the run asks its questions'),
			Flag.filter((session) => session.trim() !== '', () => 'a session name'),
			Flag.optional,
		),
	},
	({ epic: identifier, replyTo }) =>
		Effect.gen(function* () {
			// Dispatch would not claim the epic, so its request would wait for a later claim, which would then ask an old session.
			if (Option.exists(yield* runOf(identifier), (run) => !isOver(run))) {
				return yield* new Refused({ message: `${identifier} has a run that is not over` });
			}

			const config = yield* AppConfig;
			const linear = yield* Linear;
			const [epic] = yield* linear.epicsByIdentifier([identifier]);

			if (!epic) {
				return yield* new Refused({ message: `there is no issue ${identifier} in Linear` });
			}

			if (epic.parent !== null) {
				return yield* new Refused({ message: `${identifier} is a sub-issue of ${epic.parent.identifier}; dispatch ${epic.parent.identifier} instead` });
			}

			if (Option.isNone(yield* projectOf(epic.team.name))) {
				return yield* new Refused({ message: `${identifier} is in team ${epic.team.name}, which sapphire-agent does not watch` });
			}

			const ready = Option.flatMap(yield* linearTeam(epic.team.name), (team) => Option.fromUndefinedOr(team.states.nodes.find((state) => state.name === config.states.ready)));

			if (Option.isNone(ready)) {
				return yield* new Refused({ message: `team ${epic.team.name} has no workflow state ${config.states.ready}` });
			}

			// Recorded before the move, so the claim that follows it finds the request.
			yield* Journal.use((journal) => journal.addRequest({ _tag: 'start', identifier, replyTo: Option.getOrNull(replyTo) }));

			if (epic.state.id !== ready.value.id) {
				yield* linear.moveIssue(epic.id, ready.value.id);
			}

			const stuck = epic.labels.nodes.some((label) => label.name === config.labels.stuck);

			yield* wake;
			yield* Console.log(
				`${identifier} is in ${config.states.ready}${stuck ? `, but it has the ${config.labels.stuck} label, so it is not dispatched until that is removed` : '; it is dispatched once a slot is free'}`,
			);
		}),
).pipe(Command.withDescription("Moves the top-level epic to its team's ready state, so it is dispatched"));

const stop = Command.make('stop', { epic: epicArgument }, ({ epic: identifier }) =>
	Effect.gen(function* () {
		const run = Option.filter(yield* runOf(identifier), isInFlight);

		if (Option.isNone(run)) {
			return yield* new Refused({ message: `${identifier} has no run in flight` });
		}

		yield* record({ _tag: 'stop', identifier }, `${identifier}'s run is stopped and its T3 thread interrupted on the next tick`);
	}),
).pipe(Command.withDescription("Ends the epic's run: interrupts its T3 thread"));

const send = Command.make('send', { epic: epicArgument, message: words('message', 'What to type into the agent') }, ({ epic: identifier, message }) =>
	Effect.gen(function* () {
		if (!Option.exists(yield* runOf(identifier), acceptsMessages)) {
			return yield* new Refused({ message: `${identifier} has no agent running` });
		}

		yield* record({ _tag: 'send', identifier, text: message }, `the message is sent to ${identifier}'s agent on the next tick`);
	}),
).pipe(Command.withDescription("Types a message into the epic's agent"));

const followUp = Command.make(
	'follow-up',
	{
		epic: epicArgument,
		instruction: words('instruction', 'What the follow-up should change').pipe(Argument.optional),
		threads: Flag.String('threads').pipe(Flag.withDescription('A review thread id it should answer and resolve'), Flag.atLeast(0)),
	},
	({ epic: identifier, instruction, threads }) =>
		Effect.gen(function* () {
			if (!Option.exists(yield* runOf(identifier), (run) => run.status !== 'kept')) {
				return yield* new Refused({ message: `${identifier} has no run to follow up on` });
			}

			if (Option.isNone(instruction) && threads.length === 0) {
				return yield* new Refused({ message: 'give an instruction, --threads, or both' });
			}

			yield* record(
				{ _tag: 'follow-up', identifier, instruction: Option.getOrNull(instruction), threadIds: threads },
				`${identifier} gets a follow-up once its run ended, while it is in To Review without the stuck label and a slot is free`,
			);
		}),
).pipe(Command.withDescription("Starts a follow-up run on the epic's PR"));

const session = Command.make('session', { epic: epicArgument }, ({ epic: identifier }) =>
	Effect.gen(function* () {
		const run = yield* runOf(identifier);

		if (Option.isNone(run)) {
			return yield* new Refused({ message: `${identifier} has no run` });
		}

		if (run.value.session === null) {
			return yield* new Refused({ message: `${identifier}'s run has no recorded session` });
		}

		yield* Console.log(run.value.session.name);
	}),
).pipe(Command.withDescription("Prints the name of the Claude session of the epic's run, which other Claude sessions message it by"));

const commandWith = (url: string) =>
	Journal.use((journal) => journal.listCommands).pipe(Effect.map((commands) => Option.fromUndefinedOr(commands.find((command) => command.url === url))));

const reply = Command.make('reply', { url: Argument.String('comment-url'), text: words('text', 'What to say') }, ({ url, text }) =>
	Effect.gen(function* () {
		const command = yield* commandWith(url);

		if (Option.isNone(command)) {
			return yield* new Refused({ message: `${url} is not a comment that mentioned the bot` });
		}

		yield* record({ _tag: 'reply', commandId: command.value.id, body: text }, `the bot replies on ${url} on the next tick`);
	}),
).pipe(Command.withDescription('Replies as the bot on the issue or PR of the comment that mentioned it'));

const done = Command.make('done', { command: Argument.String('command').pipe(Argument.withDescription('The command, e.g. CMD-3')) }, ({ command: identifier }) =>
	Effect.gen(function* () {
		const commands = yield* Journal.use((journal) => journal.listCommands);
		const command = commands.find((candidate) => commandIdentifier(candidate) === identifier.toUpperCase());

		// The agent can finish before its start is recorded, while the command is still claimed.
		if (!command || (command.status !== 'claimed' && command.status !== 'running')) {
			return yield* new Refused({ message: `${identifier} is not in flight` });
		}

		yield* record({ _tag: 'done', commandId: command.id }, `${commandIdentifier(command)} ends once its agent stops`);
	}),
).pipe(Command.withDescription('Says the command is done, so its T3 thread is settled'));

const teamArgument = Argument.String('team').pipe(Argument.withDescription('The exact name of a Linear team, e.g. Unbound'));

// `~` expanded, relative to where the CLI runs.
const absolutePath = (path: string) => resolve(toPath(path));

const checkDirectory = (path: string) =>
	Effect.gen(function* () {
		const info = yield* (yield* FileSystem.FileSystem).stat(path).pipe(
			Effect.catchTag('PlatformError', (error) => new Refused({ message: error.reason._tag === 'NotFound' ? `${path} does not exist` : `cannot read ${path}: ${error.message}` })),
		);

		if (info.type !== 'Directory') {
			return yield* new Refused({ message: `${path} is not a directory` });
		}
	});

const checkRepo = (path: string) =>
	checkDirectory(path).pipe(
		Effect.andThen(
			Git.use((git) => git.githubRepo(path)).pipe(Effect.mapError((error) => new Refused({ message: `${path} is not a git repo with a GitHub origin: ${error.message}` }))),
		),
	);

// Checked before the request is recorded, so a project the service applies can be dispatched from.
const checkProject = ({ repo, labelReposDirectory }: Project) =>
	checkRepo(repo).pipe(Effect.andThen(labelReposDirectory === null ? Effect.void : checkDirectory(labelReposDirectory)));

const projectList = Command.make('list', {}, () =>
	Effect.gen(function* () {
		yield* Console.log(describeProjects(yield* Journal.use((journal) => journal.listProjects)));
	}),
).pipe(Command.withDescription('The projects: each Linear team sapphire-agent watches and the local clone its epics run in'));

const labelReposFlag = Flag.String('label-repos').pipe(Flag.withDescription('The directory an epic labelled repo:<name> runs in <name> of'), Flag.optional);

const projectAdd = Command.make('add', { team: teamArgument, repo: Argument.String('repo').pipe(Argument.withDescription('The local clone the epics run in')), labelRepos: labelReposFlag }, ({ team, repo, labelRepos }) =>
	Effect.gen(function* () {
		if (Option.isSome(yield* projectOf(team))) {
			return yield* new Refused({ message: `project ${team} exists already; change it with project edit` });
		}

		if (Option.isNone(yield* linearTeam(team))) {
			return yield* new Refused({ message: `there is no team ${team} in Linear` });
		}

		const project = { team, repo: absolutePath(repo), labelReposDirectory: Option.getOrNull(Option.map(labelRepos, absolutePath)) };

		yield* checkProject(project);
		yield* record({ _tag: 'project-add', project }, `project ${team} is added on the next tick`);
	}),
).pipe(Command.withDescription('Watches the Linear team, whose epics run in the repo'));

const projectEdit = Command.make(
	'edit',
	{ team: teamArgument, repo: Flag.String('repo').pipe(Flag.withDescription('The local clone the epics run in'), Flag.optional), labelRepos: labelReposFlag },
	({ team, repo, labelRepos }) =>
		Effect.gen(function* () {
			const current = yield* projectOf(team);

			if (Option.isNone(current)) {
				return yield* new Refused({ message: `there is no project ${team}` });
			}

			if (Option.isNone(repo) && Option.isNone(labelRepos)) {
				return yield* new Refused({ message: 'give --repo, --label-repos, or both' });
			}

			const project = {
				team,
				repo: Option.getOrElse(Option.map(repo, absolutePath), () => current.value.repo),
				labelReposDirectory: Option.getOrElse(Option.map(labelRepos, absolutePath), () => current.value.labelReposDirectory),
			};

			yield* checkProject(project);
			yield* record({ _tag: 'project-edit', project }, `project ${team} is changed on the next tick`);
		}),
).pipe(Command.withDescription("Changes the project's repo or label repos directory"));

const projectRemove = Command.make('remove', { team: teamArgument }, ({ team }) =>
	Effect.gen(function* () {
		if (Option.isNone(yield* projectOf(team))) {
			return yield* new Refused({ message: `there is no project ${team}` });
		}

		const linear = yield* linearTeam(team);
		const runs = yield* Journal.use((journal) => journal.listRuns);

		if (Option.exists(linear, ({ id }) => hasRunInFlight(runs, id))) {
			return yield* new Refused({ message: `project ${team} has a run in flight; stop it first` });
		}

		yield* record({ _tag: 'project-remove', team }, `project ${team} is removed on the next tick`);
	}),
).pipe(Command.withDescription('Stops watching the Linear team'));

const project = Command.make('project').pipe(
	Command.withSubcommands([projectList, projectAdd, projectEdit, projectRemove]),
	Command.withDescription('Lists, adds, changes and removes the projects'),
);

const t3Status = Command.make('status', {}, () =>
	Effect.gen(function* () {
		const { t3: settings } = yield* AppConfig;
		const { expiresAt } = yield* T3Config;
		const t3 = yield* T3;
		const expires = new Date(expiresAt).toISOString();

		yield* t3.ping.pipe(
			Effect.catchTag('T3Unauthorized', () => new Refused({ message: `T3 rejects the token in ${settings.tokenFile}, which expires ${expires}; run scripts/mint-t3-token.sh again` })),
		);
		yield* Console.log(`token: accepted, expires ${expires}`);

		const projects = yield* Journal.use((journal) => journal.listProjects);
		const projectIds = yield* Effect.forEach(projects, ({ repo }) => T3Projects.use((t3Projects) => t3Projects.projectFor(repo)));
		// Listed after the lookups, so it has the projects they created.
		const known = yield* t3.listProjects;

		for (const [index, { team, repo, labelReposDirectory }] of projects.entries()) {
			const projectId = projectIds[index];
			const title = Option.match(Option.fromUndefinedOr(known.find(({ id }) => id === projectId)), { onNone: () => 'missing from T3', onSome: (found) => found.title });

			yield* Console.log(`project ${team}: ${repo} is T3 project ${projectId} (${title})`);

			if (labelReposDirectory !== null) {
				const labelRepos = known.filter(({ workspaceRoot }) => dirname(toPath(workspaceRoot)) === labelReposDirectory);
				const described = labelRepos.map(({ id, workspaceRoot }) => `${basename(workspaceRoot)} is T3 project ${id}`).join(', ');

				yield* Console.log(`  label repos in ${labelReposDirectory}: ${described || 'none in T3 yet'}`);
			}
		}
	}),
).pipe(Command.withDescription("Whether T3 accepts the token and when it expires, and the T3 project of each project's repo, created if it has none"));

const t3Command = Command.make('t3').pipe(Command.withSubcommands([t3Status]), Command.withDescription('The T3 Code server runs are dispatched to'));

const ctl = Command.make('ctl').pipe(Command.withSubcommands([status, pause, resume, dispatch, stop, send, followUp, session, reply, done, project, t3Command]));

export const runCtl = Command.runWith(ctl, { version: '0.1.0' });

if (import.meta.main) {
	const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(journalPath(env.stateDirectory))));
	const T3Live = T3Projects.layer.pipe(Layer.provideMerge(T3.layer), Layer.provideMerge(T3Config.layer), Layer.provide(JournalLive));
	const CtlLive = Layer.mergeAll(JournalLive, Linear.layer(), Git.layer, Pause.layer, T3Live).pipe(Layer.provideMerge(AppConfig.layer), Layer.provide(FetchHttpClient.layer), Layer.provideMerge(NodeServices.layer));

	NodeRuntime.runMain(
		Effect.suspend(() => runCtl(process.argv.slice(2))).pipe(
			// Said on stderr without a stack trace, for whoever ran it.
			Effect.catchTag('Refused', (refused) =>
				Console.error(refused.message).pipe(
					Effect.andThen(
						Effect.sync(() => {
							process.exitCode = 1;
						}),
					),
				),
			),
			Effect.provide(CtlLive),
		),
	);
}
