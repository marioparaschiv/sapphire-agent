import { Context, Effect, Layer, Option, PubSub, Stream, SubscriptionRef } from 'effect';
import { type CallError, Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';
import {
	defaultTailLines,
	Herdr,
	type HerdrAgentStatus,
	type HerdrEvent,
	type OpenedTab,
	oneLine,
	openTabWith,
	ownedTabsOf,
	type Pane,
	reconnecting,
	squeezeTail,
	type StartOutcome,
	type Tab,
	type Workspace,
} from './herdr.ts';

// One pane per tab, as herdr-linear opens them.
export type FakeTab = {
	readonly tabId: string;
	readonly workspaceId: string;
	readonly label: string;
	readonly paneId: string;
	// The agent running in the pane; none once it exited and left the shell behind.
	readonly agent: Option.Option<string>;
	readonly agentStatus: HerdrAgentStatus;
	// The pane's full text; readTail returns its last lines, squeezed like the live layer.
	readonly tail: string;
};

// What `startClaude` does: Claude starts working and herdr's wait times out (`starting`, the usual case), Claude
// starts and finishes its first turn within the wait (`ready`), or herdr's wait times out with no agent (`no-agent`).
export type FakeStartBehaviour = 'starting' | 'ready' | 'no-agent';

export type FakeHerdrControls = {
	// Seeds a tab in the workspace labelled `workspace` (default: the configured workspaceLabel), creating it if needed.
	// Defaults: Claude working, empty tail.
	readonly addTab: (options: {
		readonly label: string;
		readonly workspace?: string;
		readonly agent?: string | null;
		readonly agentStatus?: HerdrAgentStatus;
		readonly tail?: string;
	}) => OpenedTab;
	readonly setAgentStatus: (paneId: string, agentStatus: HerdrAgentStatus) => void;
	// null: the agent exited and the pane's shell is left.
	readonly setAgent: (paneId: string, agent: string | null) => void;
	readonly setTail: (paneId: string, tail: string) => void;
	// The tab and its pane disappear without herdr-linear closing them.
	readonly removeTab: (tabId: string) => void;
	readonly setStartBehaviour: (behaviour: FakeStartBehaviour) => void;
	readonly tab: (tabId: string) => Option.Option<FakeTab>;
	readonly tabs: () => ReadonlyArray<FakeTab>;
	readonly workspaces: () => ReadonlyArray<Workspace>;
	readonly sentKeys: () => ReadonlyArray<{ readonly paneId: string; readonly keys: ReadonlyArray<string> }>;
	// Prompts as herdr received them, lines joined.
	readonly prompts: () => ReadonlyArray<{ readonly paneId: string; readonly text: string }>;
	readonly starts: () => ReadonlyArray<{ readonly paneId: string; readonly name: string; readonly prompt: string }>;
	// Tabs closed through the Herdr service.
	readonly closedTabs: () => ReadonlyArray<string>;
	// Delivers an event to the open event connections. State changes never emit events by themselves, so a change
	// without `emit` is a dropped event.
	readonly emit: (event: HerdrEvent) => Effect.Effect<void>;
	// Drops every open event connection; events emitted before they reconnect are lost.
	readonly disconnect: Effect.Effect<void>;
	// How often the event stream has connected so far.
	readonly connections: Effect.Effect<number>;
	// Waits until the event stream has connected `count` times in total.
	readonly awaitConnections: (count: number) => Effect.Effect<void>;
	// Counted from this call: the nth write after it fails without being applied.
	readonly failWrite: (nth: number, error: CallError) => void;
	// Counted from this call: the nth write after it is applied, then fails, as if the process died before recording it.
	readonly crashAfterWrite: (nth: number, error: CallError) => void;
};

type Signal = { readonly _tag: 'Event'; readonly event: HerdrEvent } | { readonly _tag: 'Disconnect' };

const notFound = (what: string, id: string) => new Permanent({ message: `herdr: ${what}_not_found: ${what} ${id} not found` });

// In-memory herdr: workspaces holding one-pane tabs. Writes are createWorkspace, createTab, renameTab, closeTab,
// sendKeys, prompt and startClaude.
const makeFake = (workspaceLabel: string, signals: PubSub.PubSub<Signal>, connections: SubscriptionRef.SubscriptionRef<number>) => {
	const workspaces: Array<Workspace> = [];
	const tabs: Array<FakeTab> = [];
	const sentKeys: Array<{ readonly paneId: string; readonly keys: ReadonlyArray<string> }> = [];
	const prompts: Array<{ readonly paneId: string; readonly text: string }> = [];
	const starts: Array<{ readonly paneId: string; readonly name: string; readonly prompt: string }> = [];
	const closedTabs: Array<string> = [];
	const failures = new Map<number, { readonly error: CallError; readonly afterApplying: boolean }>();
	let writes = 0;
	let ids = 0;
	let startBehaviour: FakeStartBehaviour = 'starting';

	const nextId = () => (ids += 1);

	const addWorkspace = (label: string) => {
		const workspace = { workspaceId: `w${nextId()}`, label };

		workspaces.push(workspace);

		return workspace;
	};

	const addTabTo = (workspaceId: string, label: string, agent: Option.Option<string>, agentStatus: HerdrAgentStatus, tail: string) => {
		const id = nextId();
		const tab = { tabId: `${workspaceId}:t${id}`, workspaceId, label, paneId: `${workspaceId}:p${id}`, agent, agentStatus, tail };

		tabs.push(tab);

		return tab;
	};

	const update = (paneId: string, change: Partial<Pick<FakeTab, 'label' | 'agent' | 'agentStatus' | 'tail'>>) => {
		const index = tabs.findIndex((tab) => tab.paneId === paneId);

		if (index === -1) {
			throw new Error(`no pane ${paneId}`);
		}

		tabs[index] = { ...tabs[index], ...change };
	};

	const remove = (tabId: string) => {
		const index = tabs.findIndex((tab) => tab.tabId === tabId);

		if (index !== -1) {
			tabs.splice(index, 1);
		}

		return index !== -1;
	};

	const toTab = ({ tabId, workspaceId, label, agentStatus }: FakeTab): Tab => ({ tabId, workspaceId, label, agentStatus });

	const toPane = ({ paneId, tabId, workspaceId, agent, agentStatus }: FakeTab): Pane => ({ paneId, tabId, workspaceId, agent, agentStatus });

	const byPane = (paneId: string) => Option.fromNullishOr(tabs.find((tab) => tab.paneId === paneId));

	const byTab = (tabId: string) => Option.fromNullishOr(tabs.find((tab) => tab.tabId === tabId));

	const write = <A>(apply: () => Effect.Effect<A, CallError>) =>
		Effect.suspend(() => {
			writes += 1;

			const failure = failures.get(writes);

			if (!failure) {
				return apply();
			}

			return (failure.afterApplying ? apply() : Effect.void).pipe(Effect.andThen(Effect.fail(failure.error)));
		});

	const withAgent = (paneId: string, apply: (tab: FakeTab) => Effect.Effect<void, CallError>) =>
		write(() => {
			const tab = byPane(paneId);

			if (Option.isNone(tab)) {
				return Effect.fail(notFound('pane', paneId));
			}

			return Option.isSome(tab.value.agent) ? apply(tab.value) : Effect.fail(notFound('agent', paneId));
		});

	const commands = {
		workspaces: Effect.sync(() => [...workspaces]),
		createWorkspace: (label: string, _cwd: string) =>
			write(() =>
				Effect.sync(() => {
					const workspace = addWorkspace(label);
					const tab = addTabTo(workspace.workspaceId, '1', Option.none(), 'unknown', '');

					return { workspace, tab: toTab(tab), rootPane: toPane(tab) };
				}),
			),
		createTab: (workspaceId: string, label: string, _cwd: string) =>
			write(() => {
				if (!workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
					return Effect.fail(notFound('workspace', workspaceId));
				}

				const tab = addTabTo(workspaceId, label, Option.none(), 'unknown', '');

				return Effect.succeed({ tab: toTab(tab), rootPane: toPane(tab) });
			}),
		renameTab: (tabId: string, label: string) =>
			write(() => {
				const tab = byTab(tabId);

				if (Option.isNone(tab)) {
					return Effect.fail(notFound('tab', tabId));
				}

				update(tab.value.paneId, { label });

				return Effect.void;
			}),
		tabs: (workspaceId: string) => Effect.sync(() => tabs.filter((tab) => tab.workspaceId === workspaceId).map(toTab)),
		panes: (workspaceId: string) => Effect.sync(() => tabs.filter((tab) => tab.workspaceId === workspaceId).map(toPane)),
	};

	const herdr = Herdr.of({
		...commands,
		tab: (tabId) => Effect.sync(() => Option.map(byTab(tabId), toTab)),
		pane: (paneId) => Effect.sync(() => Option.map(byPane(paneId), toPane)),
		closeTab: (tabId) =>
			write(() =>
				Effect.sync(() => {
					const closed = remove(tabId);

					if (closed) {
						closedTabs.push(tabId);
					}

					return closed;
				}),
			),
		readTail: (paneId, lines = defaultTailLines) => Effect.sync(() => Option.map(byPane(paneId), ({ tail }) => squeezeTail(tail.split('\n').slice(-lines).join('\n')))),
		agent: (paneId) =>
			Effect.sync(() =>
				byPane(paneId).pipe(
					Option.filter((tab) => Option.isSome(tab.agent)),
					Option.map(toPane),
				),
			),
		sendKeys: (paneId, keys) => withAgent(paneId, () => Effect.sync(() => sentKeys.push({ paneId, keys: [...keys] }))),
		prompt: (paneId, text) =>
			withAgent(paneId, (tab) =>
				tab.agentStatus === 'blocked'
					? Effect.fail(new Permanent({ message: `herdr: agent_blocked: agent ${paneId} is blocked and requires interactive input` }))
					: Effect.sync(() => prompts.push({ paneId, text: oneLine(text) })),
			),
		startClaude: (paneId, name, prompt) =>
			write(() => {
				if (Option.isNone(byPane(paneId))) {
					return Effect.fail(notFound('pane', paneId));
				}

				starts.push({ paneId, name, prompt: oneLine(prompt) });

				if (startBehaviour !== 'no-agent') {
					update(paneId, { agent: Option.some('claude'), agentStatus: startBehaviour === 'ready' ? 'idle' : 'working' });
				}

				return Effect.succeed<StartOutcome>(startBehaviour === 'ready' ? 'ready' : 'starting');
			}),
		openTab: openTabWith(commands, workspaceLabel),
		ownedTabs: ownedTabsOf(commands, workspaceLabel),
		events: reconnecting(
			Stream.unwrap(
				Effect.gen(function* () {
					const subscription = yield* PubSub.subscribe(signals);

					yield* SubscriptionRef.update(connections, (count) => count + 1);

					return Stream.fromSubscription(subscription).pipe(
						Stream.mapEffect((signal) => (signal._tag === 'Event' ? Effect.succeed(signal.event) : Effect.fail(new Transient({ message: 'herdr socket closed' })))),
					);
				}),
			),
		),
	});

	const controls: FakeHerdrControls = {
		addTab: ({ label, workspace = workspaceLabel, agent = 'claude', agentStatus = 'working', tail = '' }) => {
			const { workspaceId } = workspaces.find((candidate) => candidate.label === workspace) ?? addWorkspace(workspace);
			const { tabId, paneId } = addTabTo(workspaceId, label, Option.fromNullishOr(agent), agentStatus, tail);

			return { tabId, paneId };
		},
		setAgentStatus: (paneId, agentStatus) => update(paneId, { agentStatus }),
		setAgent: (paneId, agent) => update(paneId, { agent: Option.fromNullishOr(agent), ...(agent === null ? { agentStatus: 'unknown' } : {}) }),
		setTail: (paneId, tail) => update(paneId, { tail }),
		removeTab: (tabId) => {
			remove(tabId);
		},
		setStartBehaviour: (behaviour) => {
			startBehaviour = behaviour;
		},
		tab: byTab,
		tabs: () => [...tabs],
		workspaces: () => [...workspaces],
		sentKeys: () => [...sentKeys],
		prompts: () => [...prompts],
		starts: () => [...starts],
		closedTabs: () => [...closedTabs],
		emit: (event) => PubSub.publish(signals, { _tag: 'Event', event }).pipe(Effect.asVoid),
		disconnect: PubSub.publish(signals, { _tag: 'Disconnect' }).pipe(Effect.asVoid),
		connections: SubscriptionRef.get(connections),
		awaitConnections: (count) =>
			SubscriptionRef.changes(connections).pipe(
				Stream.takeUntil((connected) => connected >= count),
				Stream.runDrain,
			),
		failWrite: (nth, error) => {
			failures.set(writes + nth, { error, afterApplying: false });
		},
		crashAfterWrite: (nth, error) => {
			failures.set(writes + nth, { error, afterApplying: true });
		},
	};

	return { herdr, controls };
};

// In-memory herdr whose openTab, ownedTabs, tail squeezing and event reconnection are the live layer's. Its layer
// provides both Herdr and these controls, with fresh state each time it is built.
export class FakeHerdr extends Context.Service<FakeHerdr, FakeHerdrControls>()('herdr-linear/FakeHerdr') {
	static readonly layer = Layer.effectContext(
		Effect.gen(function* () {
			const { workspaceLabel } = yield* AppConfig;
			const signals = yield* PubSub.unbounded<Signal>();
			const connections = yield* SubscriptionRef.make(0);
			const { herdr, controls } = makeFake(workspaceLabel, signals, connections);

			return Context.make(Herdr, herdr).pipe(Context.add(FakeHerdr, controls));
		}),
	);
}
