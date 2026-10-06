import { NodeSocket } from '@effect/platform-node';
import { Context, Duration, Effect, Layer, Option, Result, Schedule, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Socket } from 'effect/socket';
import { type CallError, callTimeouts, Permanent, Transient, withCallPolicy, withWritePolicy } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { AgentStatus, type Project } from './journal.ts';

export const HerdrAgentStatus = AgentStatus.pick(['working', 'idle', 'done', 'blocked', 'unknown']);

export type HerdrAgentStatus = typeof HerdrAgentStatus.Type;

export const Workspace = Schema.Struct({ workspaceId: Schema.String, label: Schema.String }).pipe(Schema.encodeKeys({ workspaceId: 'workspace_id' }));

export type Workspace = typeof Workspace.Type;

// agentStatus sums up the agents in all of the tab's panes.
export const Tab = Schema.Struct({ tabId: Schema.String, workspaceId: Schema.String, label: Schema.String, agentStatus: HerdrAgentStatus }).pipe(
	Schema.encodeKeys({ tabId: 'tab_id', workspaceId: 'workspace_id', agentStatus: 'agent_status' }),
);

export type Tab = typeof Tab.Type;

// `agent get` returns the same fields as `pane get`, and fails with agent_not_found when no agent runs in the pane.
export const Pane = Schema.Struct({
	paneId: Schema.String,
	tabId: Schema.String,
	workspaceId: Schema.String,
	// The agent herdr detected in the pane, e.g. `claude`.
	agent: Schema.OptionFromOptionalNullOr(Schema.String),
	agentStatus: HerdrAgentStatus,
}).pipe(Schema.encodeKeys({ paneId: 'pane_id', tabId: 'tab_id', workspaceId: 'workspace_id', agentStatus: 'agent_status' }));

export type Pane = typeof Pane.Type;

// A tab in an agent workspace whose label starts with an issue identifier, with its root pane.
export const OwnedTab = Schema.Struct({
	identifier: Schema.String,
	tabId: Schema.String,
	workspaceId: Schema.String,
	label: Schema.String,
	paneId: Schema.String,
	agent: Schema.Option(Schema.String),
	agentStatus: HerdrAgentStatus,
});

export type OwnedTab = typeof OwnedTab.Type;

// Any tab in an agent workspace, with its root pane. `identifier` is none for a tab whose label does
// not start with one, e.g. a user's tab or a run's tab the user renamed.
export type WorkspaceTab = Omit<OwnedTab, 'identifier'> & { readonly identifier: Option.Option<string> };

export const OpenedTab = Schema.Struct({ tabId: Schema.String, paneId: Schema.String });

export type OpenedTab = typeof OpenedTab.Type;

// `agent start` returns once the agent is ready for input, which with an initial prompt means after that prompt's
// whole turn. So it nearly always times out, which means Claude is still starting; confirm with `agent`.
export const StartOutcome = Schema.Literals(['ready', 'starting']);

export type StartOutcome = typeof StartOutcome.Type;

export const HerdrEvent = Schema.TaggedUnion({
	AgentStatusChanged: { paneId: Schema.String, agentStatus: HerdrAgentStatus },
	// Also sent when the agent exits and herdr releases the pane.
	AgentDetected: { paneId: Schema.String, workspaceId: Schema.String },
	PaneExited: { paneId: Schema.String },
	PaneClosed: { paneId: Schema.String },
	TabClosed: { tabId: Schema.String },
});

export type HerdrEvent = typeof HerdrEvent.Type;

export const defaultTailLines = 40;

const ownedLabel = /^([A-Z]+-\d+) /;

export const identifierOf = (label: string) => Option.fromNullishOr(ownedLabel.exec(label)?.[1]);

// Runs of blank lines are squeezed to one; a TUI pads its screen with them.
export const squeezeTail = (text: string) =>
	text
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
		.join('\n')
		.trim();

// herdr rejects newlines in a prompt, so lines are joined with spaces.
export const oneLine = (text: string) => text.trim().replace(/\s*[\r\n]+\s*/g, ' ');

// Variables set in a new pane's shell, on top of what herdr passes on.
export type TabEnv = Readonly<Record<string, string>>;

// What the commands below need to find owned tabs and open new ones; both the live and the fake herdr provide it.
type Commands = Pick<Herdr['Service'], 'workspaces' | 'createWorkspace' | 'createTab' | 'renameTab' | 'tabs' | 'panes'>;

// A workspace per project's team for its runs, and workspaceLabel for command agents whose repo belongs to no project.
export const agentWorkspaceLabels = (projects: ReadonlyArray<Pick<Project, 'team'>>, workspaceLabel: string) => [...projects.map(({ team }) => team), workspaceLabel];

const findWorkspace = (commands: Commands, workspaceLabel: string) =>
	commands.workspaces.pipe(Effect.map((workspaces) => Option.fromNullishOr(workspaces.find((workspace) => workspace.label === workspaceLabel))));

const tabsIn = (commands: Commands, workspaces: ReadonlyArray<Workspace>): Effect.Effect<ReadonlyArray<WorkspaceTab>, CallError> =>
	Effect.forEach(
		workspaces,
		({ workspaceId }) =>
			Effect.all([commands.tabs(workspaceId), commands.panes(workspaceId)], { concurrency: 'unbounded' }).pipe(
				Effect.map(([tabs, panes]) =>
					tabs.flatMap((tab) => {
						// herdr lists a tab's root pane first.
						const pane = panes.find((candidate) => candidate.tabId === tab.tabId);

						if (!pane) {
							return [];
						}

						return [
							{ identifier: identifierOf(tab.label), tabId: tab.tabId, workspaceId, label: tab.label, paneId: pane.paneId, agent: pane.agent, agentStatus: pane.agentStatus },
						];
					}),
				),
			),
		{ concurrency: 'unbounded' },
	).pipe(Effect.map((perWorkspace) => perWorkspace.flat()));

const agentWorkspacesIn = (workspaces: ReadonlyArray<Workspace>, labels: ReadonlyArray<string>) => workspaces.filter((workspace) => labels.includes(workspace.label));

export const workspaceTabsOf = (commands: Commands, labels: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<WorkspaceTab>, CallError> =>
	commands.workspaces.pipe(Effect.flatMap((workspaces) => tabsIn(commands, agentWorkspacesIn(workspaces, labels))));

const ownedOf = (tabs: ReadonlyArray<WorkspaceTab>): ReadonlyArray<OwnedTab> =>
	tabs.flatMap((tab) => (Option.isSome(tab.identifier) ? [{ ...tab, identifier: tab.identifier.value }] : []));

export const openTabWith =
	(commands: Commands) =>
	(workspaceLabel: string, label: string, cwd: string, env: TabEnv = {}): Effect.Effect<OpenedTab, CallError> =>
		Effect.gen(function* () {
			const workspace = yield* findWorkspace(commands, workspaceLabel);

			if (Option.isSome(workspace)) {
				const { tab, rootPane } = yield* commands.createTab(workspace.value.workspaceId, label, cwd, env);

				return { tabId: tab.tabId, paneId: rootPane.paneId };
			}

			const { tab, rootPane } = yield* commands.createWorkspace(workspaceLabel, cwd, env);

			yield* commands.renameTab(tab.tabId, label);

			return { tabId: tab.tabId, paneId: rootPane.paneId };
		});

// 1 s, 2 s, 4 s ... up to 30 s between attempts; back to 1 s once an event arrives.
const reconnectSchedule = Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')]);

// Keeps one connection's events flowing: a connection that ends is opened again at once, one that fails after the
// reconnect delay. Events sent while disconnected are lost, which the poll covers.
export const reconnecting = <E>(connect: Stream.Stream<HerdrEvent, E>): Stream.Stream<HerdrEvent> =>
	connect.pipe(
		Stream.forever,
		Stream.tapError((error) => Effect.logWarning('herdr event stream dropped; reconnecting', error)),
		Stream.retry(reconnectSchedule),
		// The schedule never gives up, so no failure gets past it.
		Stream.orDie,
	);

export class Herdr extends Context.Service<
	Herdr,
	{
		readonly workspaces: Effect.Effect<ReadonlyArray<Workspace>, CallError>;
		// The new pane's shell skips its automatic Claude launch (HERDR_BLANK=1) and the workspace does not take focus.
		readonly createWorkspace: (label: string, cwd: string, env?: TabEnv) => Effect.Effect<{ readonly workspace: Workspace; readonly tab: Tab; readonly rootPane: Pane }, CallError>;
		readonly createTab: (workspaceId: string, label: string, cwd: string, env?: TabEnv) => Effect.Effect<{ readonly tab: Tab; readonly rootPane: Pane }, CallError>;
		readonly renameTab: (tabId: string, label: string) => Effect.Effect<void, CallError>;
		readonly tabs: (workspaceId: string) => Effect.Effect<ReadonlyArray<Tab>, CallError>;
		readonly panes: (workspaceId: string) => Effect.Effect<ReadonlyArray<Pane>, CallError>;
		readonly pane: (paneId: string) => Effect.Effect<Option.Option<Pane>, CallError>;
		// False when the tab was already gone.
		readonly closeTab: (tabId: string) => Effect.Effect<boolean, CallError>;
		// The last lines of the pane, blank-line runs squeezed; none when the pane is gone.
		readonly readTail: (paneId: string, lines?: number) => Effect.Effect<Option.Option<string>, CallError>;
		// The pane while an agent runs in it; none when the pane is gone or has no agent.
		readonly agent: (paneId: string) => Effect.Effect<Option.Option<Pane>, CallError>;
		readonly sendKeys: (paneId: string, keys: ReadonlyArray<string>) => Effect.Effect<void, CallError>;
		// Lines are joined with spaces. herdr refuses a prompt while the agent sits at a dialog (agent_blocked).
		readonly prompt: (paneId: string, text: string) => Effect.Effect<void, CallError>;
		// `args` go to Claude before the prompt.
		readonly startClaude: (paneId: string, name: string, prompt: string, args?: ReadonlyArray<string>) => Effect.Effect<StartOutcome, CallError>;
		// A new tab in the workspace labelled workspaceLabel, creating the workspace when there is none.
		readonly openTab: (workspaceLabel: string, label: string, cwd: string, env?: TabEnv) => Effect.Effect<OpenedTab, CallError>;
		// The tabs of the workspaces with these labels (agentWorkspaceLabels).
		readonly workspaceTabs: (workspaceLabels: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<WorkspaceTab>, CallError>;
		// Status, exit and close events of owned panes and tabs, in the workspaces with these labels as each connection
		// reads them. Never fails: reconnects with backoff. Events are not durable, so they only make a tick come sooner;
		// the poll stays authoritative.
		readonly events: (workspaceLabels: Effect.Effect<ReadonlyArray<string>>) => Stream.Stream<HerdrEvent>;
	}
>()('sapphire-agent/Herdr') {
	static readonly layer = Layer.effect(
		Herdr,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { env } = yield* AppConfig;

			const exec = (args: ReadonlyArray<string>) => {
				const command = `herdr ${args.join(' ')}`;
				const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString);

				return Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(
							ChildProcess.make(env.herdrBinPath, args, { env: { HERDR_SOCKET_PATH: env.herdrSocketPath }, extendEnv: true }),
						);
						const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' });

						if (exitCode === 0) {
							return stdout;
						}

						const failure = decodeErrorResponse(stderr);

						if (Option.isNone(failure)) {
							return yield* new Permanent({ message: `${command} failed with exit code ${exitCode}: ${stderr.trim()}` });
						}

						return yield* new HerdrError({ command, ...failure.value.error });
					}),
				).pipe(Effect.catchTag('PlatformError', (error) => Effect.fail(new Permanent({ message: `${command}: ${error.message}`, cause: error }))));
			};

			const decode =
				<A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>) =>
				(stdout: string) =>
					Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ result: schema })))(stdout).pipe(
						Effect.map(({ result }) => result),
						Effect.mapError((error) => new Permanent({ message: `herdr ${args.join(' ')}: ${error.message}`, cause: error })),
					);

			const call = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>, policy = withCallPolicy(callTimeouts.herdr)) =>
				exec(args).pipe(
					Effect.flatMap(decode(schema, args)),
					Effect.catchTag('HerdrError', (error) => Effect.fail(classify(error))),
					policy,
				);

			const write = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>) => call(schema, args, withWritePolicy(callTimeouts.herdr));

			// The herdr error codes in `missing` give none instead of failing.
			const find = <A>(schema: Schema.Decoder<A>, args: ReadonlyArray<string>, missing: ReadonlyArray<string>, policy = withCallPolicy(callTimeouts.herdr)) =>
				exec(args).pipe(
					Effect.flatMap(decode(schema, args)),
					Effect.map(Option.some),
					Effect.catchTag('HerdrError', (error) => (missing.includes(error.code) ? Effect.succeed(Option.none<A>()) : Effect.fail(classify(error)))),
					policy,
				);

			const blank = (env: TabEnv) => [...Object.entries({ HERDR_BLANK: '1', ...env }).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];

			const commands = {
				workspaces: call(Schema.Struct({ workspaces: Schema.Array(Workspace) }), ['workspace', 'list']).pipe(Effect.map(({ workspaces }) => workspaces)),
				createWorkspace: (label: string, cwd: string, env: TabEnv = {}) =>
					write(Schema.Struct({ workspace: Workspace, tab: Tab, rootPane: Pane }).pipe(Schema.encodeKeys({ rootPane: 'root_pane' })), [
						'workspace',
						'create',
						'--label',
						label,
						'--cwd',
						cwd,
						...blank(env),
					]),
				createTab: (workspaceId: string, label: string, cwd: string, env: TabEnv = {}) =>
					write(Schema.Struct({ tab: Tab, rootPane: Pane }).pipe(Schema.encodeKeys({ rootPane: 'root_pane' })), [
						'tab',
						'create',
						'--workspace',
						workspaceId,
						'--label',
						label,
						'--cwd',
						cwd,
						...blank(env),
					]),
				renameTab: (tabId: string, label: string) => call(Schema.Unknown, ['tab', 'rename', tabId, label]).pipe(Effect.asVoid),
				tabs: (workspaceId: string) => call(Schema.Struct({ tabs: Schema.Array(Tab) }), ['tab', 'list', '--workspace', workspaceId]).pipe(Effect.map(({ tabs }) => tabs)),
				panes: (workspaceId: string) =>
					call(Schema.Struct({ panes: Schema.Array(Pane) }), ['pane', 'list', '--workspace', workspaceId]).pipe(Effect.map(({ panes }) => panes)),
			};

			const connect = (workspaceLabels: Effect.Effect<ReadonlyArray<string>>) => Stream.unwrap(
				Effect.gen(function* () {
					const workspaces = yield* commands.workspaces;
					const agentWorkspaces = agentWorkspacesIn(workspaces, yield* workspaceLabels);
					const owned = ownedOf(yield* tabsIn(commands, agentWorkspaces));
					const paneIds = new Set(owned.map(({ paneId }) => paneId));
					const tabIds = new Set(owned.map(({ tabId }) => tabId));
					const knownWorkspaceIds = new Set(workspaces.map(({ workspaceId }) => workspaceId));
					const agentWorkspaceIds = new Set(agentWorkspaces.map(({ workspaceId }) => workspaceId));
					const socket = yield* NodeSocket.makeNet({ path: env.herdrSocketPath });
					const writer = yield* socket.writer;
					const isOwned = HerdrEvent.match({
						AgentStatusChanged: ({ paneId }) => paneIds.has(paneId),
						AgentDetected: ({ paneId }) => paneIds.has(paneId),
						PaneExited: ({ paneId }) => paneIds.has(paneId),
						PaneClosed: ({ paneId }) => paneIds.has(paneId),
						TabClosed: ({ tabId }) => tabIds.has(tabId),
					});
					// An agent we are not subscribed to, in an agent workspace or in one created since we connected, which may
					// be an agent workspace opened for its first run.
					const isNewRun = (event: HerdrEvent) =>
						event._tag === 'AgentDetected' &&
						!paneIds.has(event.paneId) &&
						(agentWorkspaceIds.has(event.workspaceId) || !knownWorkspaceIds.has(event.workspaceId));
					const events = Socket.toStream(socket).pipe(
						Stream.decodeText(),
						Stream.splitLines,
						Stream.filter((line) => line.trim() !== ''),
						Stream.mapEffect(decodeMessage),
						Stream.filterMap((message) => Result.fromOption(message, () => undefined)),
						Stream.filter((event) => isOwned(event) || isNewRun(event)),
						// Status changes need a subscription per pane, and herdr takes one subscription request per connection.
						// So a new run ends the connection, and the next one subscribes to the run's pane too.
						Stream.takeWhile(isOwned),
					);

					return Stream.merge(events, Stream.fromEffectDrain(writer.write(`${JSON.stringify(subscribeRequest(paneIds))}\n`)));
				}),
			);

			const startWait = Duration.seconds(30);

			return Herdr.of({
				...commands,
				pane: (paneId) => find(Schema.Struct({ pane: Pane }), ['pane', 'get', paneId], ['pane_not_found']).pipe(Effect.map(Option.map(({ pane }) => pane))),
				closeTab: (tabId) => find(Schema.Unknown, ['tab', 'close', tabId], ['tab_not_found']).pipe(Effect.map(Option.isSome)),
				readTail: (paneId, lines = defaultTailLines) =>
					exec(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)]).pipe(
						Effect.map((text) => Option.some(squeezeTail(text))),
						Effect.catchTag('HerdrError', (error) => (error.code === 'pane_not_found' ? Effect.succeed(Option.none<string>()) : Effect.fail(classify(error)))),
						withCallPolicy(callTimeouts.herdr),
					),
				agent: (paneId) =>
					find(Schema.Struct({ agent: Pane }), ['agent', 'get', paneId], ['agent_not_found', 'pane_not_found']).pipe(Effect.map(Option.map(({ agent }) => agent))),
				sendKeys: (paneId, keys) => write(Schema.Unknown, ['agent', 'send-keys', paneId, ...keys]).pipe(Effect.asVoid),
				prompt: (paneId, text) => write(Schema.Unknown, ['agent', 'prompt', paneId, oneLine(text)]).pipe(Effect.asVoid),
				startClaude: (paneId, name, prompt, args = []) =>
					find(
						Schema.Unknown,
						['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', String(Duration.toMillis(startWait)), '--', ...args, oneLine(prompt)],
						['timeout'],
						withWritePolicy(Duration.sum(callTimeouts.herdr, startWait)),
					).pipe(Effect.map(Option.match({ onNone: (): StartOutcome => 'starting', onSome: (): StartOutcome => 'ready' }))),
				openTab: openTabWith(commands),
				workspaceTabs: (workspaceLabels) => workspaceTabsOf(commands, workspaceLabels),
				events: (workspaceLabels) => reconnecting(connect(workspaceLabels)),
			});
		}),
	);
}

// herdr's `{ error: { code, message } }`, written to stderr by a failed command and sent on the event socket.
const ErrorResponse = Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) });

const decodeErrorResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));

class HerdrError extends Schema.TaggedError<HerdrError>()('HerdrError', { command: Schema.String, code: Schema.String, message: Schema.String }) {}

const classify = ({ command, code, message }: { readonly command: string; readonly code: string; readonly message: string }) => {
	const text = `${command}: ${code}: ${message}`;

	return code === 'server_not_running' ? new Transient({ message: text }) : new Permanent({ message: text });
};

// Lifecycle events can be subscribed to session-wide; status changes only per existing pane, one subscription
// request per connection.
const subscribeRequest = (paneIds: ReadonlySet<string>) => ({
	id: 'sapphire-agent',
	method: 'events.subscribe',
	params: {
		subscriptions: [
			{ type: 'pane.agent_detected' },
			{ type: 'pane.exited' },
			{ type: 'pane.closed' },
			{ type: 'tab.closed' },
			...[...paneIds].map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
		],
	},
});

const PaneEventData = Schema.Struct({ paneId: Schema.String }).pipe(Schema.encodeKeys({ paneId: 'pane_id' }));

const paneEventTags = { pane_exited: 'PaneExited', pane_closed: 'PaneClosed' } as const;

const SocketMessage = Schema.Union([
	Schema.Struct({ id: Schema.String, result: Schema.Struct({ type: Schema.Literal('subscription_started') }) }),
	ErrorResponse,
	Schema.Struct({
		event: Schema.Literal('pane.agent_status_changed'),
		data: Schema.Struct({ paneId: Schema.String, agentStatus: HerdrAgentStatus }).pipe(Schema.encodeKeys({ paneId: 'pane_id', agentStatus: 'agent_status' })),
	}),
	Schema.Struct({
		event: Schema.Literal('pane_agent_detected'),
		data: Schema.Struct({ paneId: Schema.String, workspaceId: Schema.String }).pipe(Schema.encodeKeys({ paneId: 'pane_id', workspaceId: 'workspace_id' })),
	}),
	Schema.Struct({ event: Schema.Literals(['pane_exited', 'pane_closed']), data: PaneEventData }),
	Schema.Struct({ event: Schema.Literal('tab_closed'), data: Schema.Struct({ tabId: Schema.String }).pipe(Schema.encodeKeys({ tabId: 'tab_id' })) }),
]);

// The event in a socket line, none for the subscription's acknowledgement; an error response fails the connection.
const decodeMessage = (line: string): Effect.Effect<Option.Option<HerdrEvent>, CallError> =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(SocketMessage))(line).pipe(
		Effect.mapError((error) => new Permanent({ message: `herdr event: ${error.message}`, cause: error })),
		Effect.flatMap((message): Effect.Effect<Option.Option<HerdrEvent>, CallError> => {
			if ('result' in message) {
				return Effect.succeed(Option.none());
			}

			if ('error' in message) {
				return Effect.fail(classify({ command: 'herdr events.subscribe', ...message.error }));
			}

			switch (message.event) {
				case 'pane.agent_status_changed':
					return Effect.succeedSome({ _tag: 'AgentStatusChanged', ...message.data });
				case 'pane_agent_detected':
					return Effect.succeedSome({ _tag: 'AgentDetected', ...message.data });
				case 'tab_closed':
					return Effect.succeedSome({ _tag: 'TabClosed', ...message.data });
				default:
					return Effect.succeedSome({ _tag: paneEventTags[message.event], ...message.data });
			}
		}),
	);
