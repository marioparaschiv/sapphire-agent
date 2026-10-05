import { join } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { AppConfig } from './config.ts';
import { type Command as CommandRow, commandIdentifier, Journal, type Request, type Run } from './journal.ts';
import { Linear } from './linear.ts';
import { isInFlight, isStarted } from './observation.ts';
import { wakeFileName } from './reconciler.ts';

// What the CLI refuses, said to whoever ran it: a person, or a command's agent.
export class Refused extends Schema.TaggedError<Refused>()('Refused', { message: Schema.String }) {}

const describeRun = (run: Run, epicState: string) =>
	[
		`${run.identifier} ${run.status} (${run.job._tag})`,
		epicState,
		`claimed ${new Date(run.claimedAt).toISOString()}`,
		run.tabId === null ? 'no tab' : `tab ${run.tabId}`,
		run.worktreePath ?? 'no worktree',
	].join(', ');

const describeCommand = (command: CommandRow) => `${commandIdentifier(command)} ${command.status}, @${command.author} in ${command.url}`;

const describeRequest = (request: Request) => {
	switch (request._tag) {
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

const epicArgument = Argument.String('epic').pipe(
	Argument.withDescription('An epic identifier, e.g. HL-12'),
	Argument.map((identifier) => identifier.toUpperCase()),
);

const words = (name: string, description: string) =>
	Argument.String(name).pipe(Argument.withDescription(description), Argument.variadic({ min: 1 }), Argument.map((parts) => parts.join(' ')));

const status = Command.make('status', {}, () =>
	Effect.gen(function* () {
		const journal = yield* Journal;
		const linear = yield* Linear;
		const runs = yield* journal.listRuns;
		const epics = yield* linear.epics(runs.map((run) => run.epicId)).pipe(Effect.result);
		const stateOf = (run: Run) =>
			epics._tag === 'Failure'
				? 'epic state unknown'
				: Option.match(Option.fromUndefinedOr(epics.success.find((epic) => epic.id === run.epicId)), { onNone: () => 'epic gone', onSome: (epic) => `epic in ${epic.state.name}` });
		const commands = (yield* journal.listCommands).filter((command) => command.status === 'queued' || command.status === 'claimed' || command.status === 'running');
		const requests = yield* journal.listRequests;

		yield* Console.log(runs.length === 0 ? 'no runs' : runs.map((run) => describeRun(run, stateOf(run))).join('\n'));

		if (epics._tag === 'Failure') {
			yield* Console.log(`cannot read the epics from Linear: ${epics.failure.message}`);
		}

		yield* Console.log(commands.length === 0 ? 'no commands' : commands.map(describeCommand).join('\n'));

		if (requests.length > 0) {
			yield* Console.log(requests.map(({ id, request }) => `request ${id}: ${describeRequest(request)}`).join('\n'));
		}
	}),
).pipe(Command.withDescription('The runs with their epics, the commands in flight and the requests not acted on yet'));

const start = Command.make('start', { epic: epicArgument }, ({ epic: identifier }) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
		const linear = yield* Linear;
		const [epic] = yield* linear.epicsByIdentifier([identifier]);

		if (!epic) {
			return yield* new Refused({ message: `there is no epic ${identifier} in Linear` });
		}

		if (!config.teams[epic.team.name]) {
			return yield* new Refused({ message: `${identifier} is in team ${epic.team.name}, which sapphire-agent does not watch` });
		}

		const ready = Option.fromUndefinedOr((yield* linear.teams([epic.team.name]))[0]?.states.nodes.find((state) => state.name === config.states.ready));

		if (Option.isNone(ready)) {
			return yield* new Refused({ message: `team ${epic.team.name} has no workflow state ${config.states.ready}` });
		}

		if (epic.state.id !== ready.value.id) {
			yield* linear.moveIssue(epic.id, ready.value.id);
		}

		const stuck = epic.labels.nodes.some((label) => label.name === config.labels.stuck);

		yield* wake;
		yield* Console.log(
			`${identifier} is in ${config.states.ready}${stuck ? `, but it has the ${config.labels.stuck} label, so it is not dispatched until that is removed` : '; it is dispatched once a slot is free'}`,
		);
	}),
).pipe(Command.withDescription("Moves the epic to its team's ready state, so it is dispatched"));

const stop = Command.make('stop', { epic: epicArgument }, ({ epic: identifier }) =>
	Effect.gen(function* () {
		if (!Option.exists(yield* runOf(identifier), isInFlight)) {
			return yield* new Refused({ message: `${identifier} has no run in flight` });
		}

		yield* record({ _tag: 'stop', identifier }, `${identifier}'s run is stopped and its tab closed on the next tick`);
	}),
).pipe(Command.withDescription("Ends the epic's run and closes its tab"));

const send = Command.make('send', { epic: epicArgument, message: words('message', 'What to type into the agent') }, ({ epic: identifier, message }) =>
	Effect.gen(function* () {
		if (!Option.exists(yield* runOf(identifier), (run) => isInFlight(run) && isStarted(run))) {
			return yield* new Refused({ message: `${identifier} has no agent running` });
		}

		yield* record({ _tag: 'send', identifier, text: message }, `the message is typed into ${identifier}'s agent on the next tick`);
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
).pipe(Command.withDescription('Says the command is done, so its tab is closed'));

const ctl = Command.make('ctl').pipe(Command.withSubcommands([status, start, stop, send, followUp, reply, done]));

export const runCtl = Command.runWith(ctl, { version: '0.1.0' });

if (import.meta.main) {
	const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(join(env.stateDirectory, 'journal.db'))));
	const CtlLive = Layer.mergeAll(JournalLive, Linear.layer()).pipe(Layer.provideMerge(AppConfig.layer), Layer.provide(FetchHttpClient.layer), Layer.provideMerge(NodeServices.layer));

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
