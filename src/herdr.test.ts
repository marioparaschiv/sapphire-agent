import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Exit, FileSystem, Fiber, Layer, Option, Queue, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Herdr, type HerdrEvent, identifierOf } from './herdr.ts';
import { FakeHerdr } from './herdr-fake.ts';

// Output captured from herdr 0.9.3.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/herdr', name), 'utf8');

type Reply = { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number };

const ok = (name: string): Reply => ({ stdout: fixture(name) });

const fails = (name: string): Reply => ({ stderr: fixture(name), exitCode: 1 });

const noWorkspaces: Reply = { stdout: '{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[]}}\n' };

const configDirectory = '/tmp/herdr-linear-test';

// Stands in for the herdr executable: answers each command line from `replies` and records the calls. A command
// without a reply fails the way an unexpected herdr failure does.
const herdrBinary = (replies: Record<string, Reply>) => {
	const calls: Array<{ readonly args: string; readonly socketPath: string | undefined }> = [];
	const encoder = new TextEncoder();

	const spawner = ChildProcessSpawner.make((command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('herdr is never piped'));
		}

		const args = command.args.join(' ');
		const { stdout = '', stderr = '', exitCode = 0 } = replies[args] ?? { stderr: `unexpected command: herdr ${args}`, exitCode: 2 };

		calls.push({ args, socketPath: command.options.env?.HERDR_SOCKET_PATH });

		return Effect.succeed(
			ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(1),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: Stream.make(encoder.encode(stdout)),
				stderr: Stream.make(encoder.encode(stderr)),
				all: Stream.make(encoder.encode(stdout + stderr)),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			}),
		);
	});

	return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

const liveHerdr = (replies: Record<string, Reply>, settings: Parameters<typeof AppConfig.layerTest>[1] = {}, directory = configDirectory) => {
	const binary = herdrBinary(replies);
	const layer = Herdr.layer.pipe(Layer.provide(binary.layer), Layer.provide(AppConfig.layerTest(directory, settings)));

	return Herdr.pipe(
		Effect.provide(layer),
		Effect.map((herdr) => ({ herdr, calls: binary.calls })),
	);
};

const lists = {
	'workspace list': ok('workspace-list.json'),
	'tab list --workspace w1': ok('tab-list.json'),
	'pane list --workspace w1': ok('pane-list.json'),
};

describe('Herdr', () => {
	it.effect('decodes the workspaces, tabs, panes and agents herdr 0.9.3 returns', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({
				...lists,
				'pane get w1:p2': ok('pane-get.json'),
				'agent get w1:p4': ok('agent-get.json'),
			});

			assert.deepStrictEqual(yield* herdr.workspaces, [
				{ workspaceId: 'w1', label: 'agents' },
				{ workspaceId: 'w2', label: 'personal' },
			]);
			assert.deepStrictEqual(yield* herdr.tabs('w1'), [
				{ tabId: 'w1:t1', workspaceId: 'w1', label: 'notes', agentStatus: 'blocked' },
				{ tabId: 'w1:t4', workspaceId: 'w1', label: 'HL-2 Renamed', agentStatus: 'working' },
				{ tabId: 'w1:t6', workspaceId: 'w1', label: 'HL-7 Start', agentStatus: 'unknown' },
			]);
			assert.deepStrictEqual(yield* herdr.panes('w1'), [
				{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agent: Option.some('claude'), agentStatus: 'blocked' },
				{ paneId: 'w1:p4', tabId: 'w1:t4', workspaceId: 'w1', agent: Option.some('claude'), agentStatus: 'working' },
				{ paneId: 'w1:p8', tabId: 'w1:t4', workspaceId: 'w1', agent: Option.none(), agentStatus: 'unknown' },
				{ paneId: 'w1:p7', tabId: 'w1:t6', workspaceId: 'w1', agent: Option.none(), agentStatus: 'unknown' },
			]);
			assert.deepStrictEqual(yield* herdr.pane('w1:p2'), Option.some({ paneId: 'w1:p2', tabId: 'w1:t2', workspaceId: 'w1', agent: Option.none(), agentStatus: 'unknown' }));
			assert.deepStrictEqual(
				yield* herdr.agent('w1:p4'),
				Option.some({ paneId: 'w1:p4', tabId: 'w1:t4', workspaceId: 'w1', agent: Option.some('claude'), agentStatus: 'working' }),
			);
			assert.deepStrictEqual(new Set(calls.map(({ socketPath }) => socketPath)), new Set([join(configDirectory, 'herdr.sock')]));
		}),
	);

	it.effect('opens a tab in the existing workspace, without focus and with a blank shell', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({
				'workspace list': ok('workspace-list.json'),
				'tab create --workspace w1 --label HL-1 Some epic --cwd /work/hl-1 --env HERDR_BLANK=1 --no-focus': ok('tab-create.json'),
			});

			assert.deepStrictEqual(yield* herdr.openTab('HL-1 Some epic', '/work/hl-1'), { tabId: 'w1:t2', paneId: 'w1:p2' });
			assert.lengthOf(calls, 2);
		}),
	);

	it.effect('creates the workspace for the first tab and gives its tab the label', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({
				'workspace list': noWorkspaces,
				'workspace create --label agents --cwd /work/hl-1 --env HERDR_BLANK=1 --no-focus': ok('workspace-create.json'),
				'tab rename w1:t1 HL-1 Some epic': ok('tab-get.json'),
			});

			assert.deepStrictEqual(yield* herdr.openTab('HL-1 Some epic', '/work/hl-1'), { tabId: 'w1:t1', paneId: 'w1:p1' });
			assert.deepStrictEqual(
				calls.map(({ args }) => args),
				['workspace list', 'workspace create --label agents --cwd /work/hl-1 --env HERDR_BLANK=1 --no-focus', 'tab rename w1:t1 HL-1 Some epic'],
			);
		}),
	);

	it.effect('lists every tab of its workspace with its root pane and agent, and the identifier where the label starts with one', () =>
		Effect.gen(function* () {
			const { herdr } = yield* liveHerdr(lists);

			// The `personal` workspace is never read.
			assert.deepStrictEqual(yield* herdr.workspaceTabs, [
				{ identifier: Option.none(), tabId: 'w1:t1', workspaceId: 'w1', label: 'notes', paneId: 'w1:p1', agent: Option.some('claude'), agentStatus: 'blocked' },
				{ identifier: Option.some('HL-2'), tabId: 'w1:t4', workspaceId: 'w1', label: 'HL-2 Renamed', paneId: 'w1:p4', agent: Option.some('claude'), agentStatus: 'working' },
				{ identifier: Option.some('HL-7'), tabId: 'w1:t6', workspaceId: 'w1', label: 'HL-7 Start', paneId: 'w1:p7', agent: Option.none(), agentStatus: 'unknown' },
			]);
		}),
	);

	it.effect('sees no tabs while its workspace does not exist', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr(lists, { workspaceLabel: 'herdr-linear' });

			assert.deepStrictEqual(yield* herdr.workspaceTabs, []);
			assert.deepStrictEqual(
				calls.map(({ args }) => args),
				['workspace list'],
			);
		}),
	);

	it('takes an identifier only from the start of a label, followed by a space', () => {
		assert.deepStrictEqual(
			['HL-12 Fix login', 'ENG-7 x', 'HL-12', 'hl-12 Fix', 'Fix HL-12 login', 'HL-x Fix'].map(identifierOf),
			[Option.some('HL-12'), Option.some('ENG-7'), Option.none(), Option.none(), Option.none(), Option.none()],
		);
	});

	it.effect('reading a pane or agent or closing a tab that no longer exists gives none and does not fail', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({
				'pane get w1:p99': fails('error-pane-not-found.json'),
				'agent get w1:p2': fails('error-agent-not-found.json'),
				'agent get w1:p99': fails('error-pane-not-found.json'),
				'tab close w1:t99': fails('error-tab-not-found.json'),
				'tab close w1:t2': ok('tab-close.json'),
				'pane read w1:p99 --source recent-unwrapped --lines 40': fails('error-pane-not-found.json'),
			});

			assert.deepStrictEqual(yield* herdr.pane('w1:p99'), Option.none());
			assert.deepStrictEqual(yield* herdr.agent('w1:p2'), Option.none());
			assert.deepStrictEqual(yield* herdr.agent('w1:p99'), Option.none());
			assert.isFalse(yield* herdr.closeTab('w1:t99'));
			assert.isTrue(yield* herdr.closeTab('w1:t2'));
			assert.deepStrictEqual(yield* herdr.readTail('w1:p99'), Option.none());
			assert.lengthOf(calls, 6);
		}),
	);

	it.effect('reads the last 40 lines of a pane with blank-line runs squeezed', () =>
		Effect.gen(function* () {
			const text = fixture('pane-read.txt');
			const { herdr } = yield* liveHerdr({
				'pane read w1:p2 --source recent-unwrapped --lines 40': { stdout: text },
				'pane read w1:p2 --source recent-unwrapped --lines 5': { stdout: text },
			});
			const [, shellPrompt, command] = text.split('\n');
			const tail = [shellPrompt, command, 'a', '', 'b'].join('\n');

			assert.deepStrictEqual(yield* herdr.readTail('w1:p2'), Option.some(tail));
			assert.deepStrictEqual(yield* herdr.readTail('w1:p2', 5), Option.some(tail));
		}),
	);

	it.effect('treats a herdr start timeout as Claude still starting, and passes the prompt as one line', () =>
		Effect.gen(function* () {
			const { herdr } = yield* liveHerdr({
				'agent start hl-1 --kind claude --pane w1:p2 --timeout 30000 -- Work on HL-1. Read the epic first.': fails('error-timeout.json'),
				'agent start hl-2 --kind claude --pane w1:p99 --timeout 30000 -- Work on HL-2.': fails('error-pane-not-found.json'),
			});

			assert.strictEqual(yield* herdr.startClaude('w1:p2', 'hl-1', 'Work on HL-1.\n\n  Read the epic first.\n'), 'starting');
			assert.deepStrictEqual(
				yield* herdr.startClaude('w1:p99', 'hl-2', 'Work on HL-2.').pipe(Effect.flip),
				new Permanent({ message: 'herdr agent start hl-2 --kind claude --pane w1:p99 --timeout 30000 -- Work on HL-2.: pane_not_found: pane w1:p99 not found' }),
			);
		}),
	);

	it.effect('fails a prompt the agent refuses as Permanent, without retrying', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({ 'agent prompt w1:p1 Yes, go ahead. Use the second option.': fails('error-agent-blocked.json') });
			const error = yield* herdr.prompt('w1:p1', 'Yes, go ahead.\nUse the second option.').pipe(Effect.flip);

			assert.strictEqual(error._tag, 'Permanent');
			assert.match(error.message, /agent_blocked: agent w1:p1 is blocked/);
			assert.lengthOf(calls, 1);
		}),
	);

	it.effect('retries while the herdr server is not running, then fails Transient', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({ 'workspace list': fails('error-server-not-running.json') });
			const fiber = yield* herdr.workspaces.pipe(Effect.forkChild);

			yield* TestClock.adjust('1 minute');

			const exit = yield* Fiber.await(fiber);

			assert.isTrue(Exit.isFailure(exit));
			assert.deepStrictEqual(
				exit,
				Exit.fail(new Transient({ message: 'herdr workspace list: server_not_running: no herdr server is running at /tmp/hs/nonexistent.sock; run `herdr` to start or attach it' })),
			);
			assert.lengthOf(calls, 4);
		}),
	);

	it.effect('fails Permanent on output it cannot decode or a failure without a herdr error', () =>
		Effect.gen(function* () {
			const { herdr, calls } = yield* liveHerdr({
				'tab list --workspace w1': ok('pane-list.json'),
				'pane list --workspace w1': { stderr: 'Segmentation fault', exitCode: 139 },
			});
			const decodeFailure = yield* herdr.tabs('w1').pipe(Effect.flip);
			const crash = yield* herdr.panes('w1').pipe(Effect.flip);

			assert.strictEqual(decodeFailure._tag, 'Permanent');
			assert.match(decodeFailure.message, /^herdr tab list --workspace w1: /);
			assert.deepStrictEqual(crash, new Permanent({ message: 'herdr pane list --workspace w1 failed with exit code 139: Segmentation fault' }));
			assert.lengthOf(calls, 2);
		}),
	);
});

type Connection = { readonly socket: Socket; readonly request: Deferred.Deferred<unknown>; readonly closed: Deferred.Deferred<void> };

// A herdr event socket the test controls: each connection's subscription request, and when the client let go of it.
const eventServer = (path: string) =>
	Effect.gen(function* () {
		const connections = yield* Queue.unbounded<Connection>();
		const server = createServer((socket) => {
			const connection = { socket, request: Deferred.makeUnsafe<unknown>(), closed: Deferred.makeUnsafe<void>() };
			let buffer = '';

			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8');

				if (buffer.includes('\n')) {
					Deferred.doneUnsafe(connection.request, Exit.succeed(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))));
				}
			});
			socket.on('close', () => Deferred.doneUnsafe(connection.closed, Exit.void));
			Queue.offerUnsafe(connections, connection);
		});

		yield* Effect.acquireRelease(
			Effect.callback<void>((resume) => {
				server.listen(path, () => resume(Effect.void));
			}),
			() =>
				Effect.callback<void>((resume) => {
					server.close(() => resume(Effect.void));
				}),
		);

		return connections;
	});

const eventLines = fixture('events.jsonl').trimEnd().split('\n');

const send = (connection: Connection, lines: ReadonlyArray<string>) => Effect.sync(() => connection.socket.write(`${lines.join('\n')}\n`));

describe('Herdr events', () => {
	it.effect('subscribes for owned panes, delivers their events, resubscribes for a new run and reconnects after a drop', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const connections = yield* eventServer(join(directory, 'herdr.sock'));
			const { herdr } = yield* liveHerdr(
				{
					'workspace list': ok('events-workspace-list.json'),
					'tab list --workspace w3': ok('events-tab-list.json'),
					'pane list --workspace w3': ok('events-pane-list.json'),
				},
				{},
				directory,
			);
			const received = yield* Queue.unbounded<HerdrEvent>();
			const subscription = {
				id: 'herdr-linear',
				method: 'events.subscribe',
				params: {
					subscriptions: [
						{ type: 'pane.agent_detected' },
						{ type: 'pane.exited' },
						{ type: 'pane.closed' },
						{ type: 'tab.closed' },
						...['w3:p1', 'w3:p2', 'w3:p3'].map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
					],
				},
			};

			yield* Effect.forkScoped(Stream.runForEach(herdr.events, (event) => Queue.offer(received, event)));

			const first = yield* Queue.take(connections);

			assert.deepStrictEqual(yield* Deferred.await(first.request), subscription);

			// Up to the agent detected in `notes`, which is not owned but in the same workspace.
			yield* send(first, eventLines.slice(0, 9));
			assert.deepStrictEqual(yield* Queue.takeN(received, 7), [
				{ _tag: 'AgentDetected', paneId: 'w3:p1', workspaceId: 'w3' },
				{ _tag: 'AgentDetected', paneId: 'w3:p2', workspaceId: 'w3' },
				{ _tag: 'PaneExited', paneId: 'w3:p2' },
				{ _tag: 'AgentStatusChanged', paneId: 'w3:p1', agentStatus: 'working' },
				{ _tag: 'AgentStatusChanged', paneId: 'w3:p1', agentStatus: 'idle' },
				{ _tag: 'AgentStatusChanged', paneId: 'w3:p2', agentStatus: 'blocked' },
				{ _tag: 'AgentStatusChanged', paneId: 'w3:p2', agentStatus: 'done' },
			]);

			const second = yield* Queue.take(connections);

			assert.deepStrictEqual(yield* Deferred.await(second.request), subscription);
			yield* send(second, eventLines.slice(9));
			assert.deepStrictEqual(yield* Queue.takeN(received, 2), [
				{ _tag: 'PaneClosed', paneId: 'w3:p3' },
				{ _tag: 'TabClosed', tabId: 'w3:t1' },
			]);

			second.socket.end();
			yield* Deferred.await(second.closed);

			// The client may not have seen the close and started its backoff yet, so time moves on until it reconnects. The
			// backoff timing itself is asserted against the fake, which reconnects the same way.
			const third = yield* TestClock.adjust('1 second').pipe(
				Effect.andThen(Queue.poll(connections)),
				Effect.repeat({ until: Option.isSome }),
				Effect.map(Option.getOrThrow),
			);

			assert.deepStrictEqual(yield* Deferred.await(third.request), subscription);
			yield* send(third, [eventLines[0], eventLines[4]]);
			assert.deepStrictEqual(yield* Queue.take(received), { _tag: 'AgentStatusChanged', paneId: 'w3:p1', agentStatus: 'working' });
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

const fakeHerdr = Effect.all([Herdr, FakeHerdr]).pipe(Effect.provide(FakeHerdr.layer.pipe(Layer.provide(AppConfig.layerTest(configDirectory)))));

describe('FakeHerdr', () => {
	it.effect('lists only the tabs of the configured workspace', () =>
		Effect.gen(function* () {
			const [herdr, fake] = yield* fakeHerdr;
			const owned = fake.addTab({ label: 'HL-3 Fix login', agentStatus: 'idle', tail: 'Done.' });
			const notes = fake.addTab({ label: 'notes' });

			fake.addTab({ label: 'HL-4 Elsewhere', workspace: 'personal' });

			assert.deepStrictEqual(
				(yield* herdr.workspaceTabs).map(({ identifier, tabId, paneId, agentStatus }) => [identifier, tabId, paneId, agentStatus]),
				[
					[Option.some('HL-3'), owned.tabId, owned.paneId, 'idle'],
						[Option.none(), notes.tabId, notes.paneId, 'working'],
				],
			);
		}),
	);

	it.effect('starts Claude as configured and records starts, keys and prompts', () =>
		Effect.gen(function* () {
			const [herdr, fake] = yield* fakeHerdr;
			const { tabId, paneId } = yield* herdr.openTab('HL-5 Sync', '/work/hl-5');

			assert.strictEqual(yield* herdr.startClaude(paneId, 'hl-5', 'Work on HL-5.\nGo.'), 'starting');
			assert.deepStrictEqual(Option.map(yield* herdr.agent(paneId), ({ agentStatus }) => agentStatus), Option.some('working'));

			fake.setStartBehaviour('no-agent');

			const other = yield* herdr.openTab('HL-6 Other', '/work/hl-6');

			assert.strictEqual(yield* herdr.startClaude(other.paneId, 'hl-6', 'Work on HL-6.'), 'starting');
			assert.deepStrictEqual(yield* herdr.agent(other.paneId), Option.none());

			yield* herdr.sendKeys(paneId, ['esc']);
			yield* herdr.prompt(paneId, 'continue');
			fake.setAgentStatus(paneId, 'blocked');

			assert.strictEqual((yield* herdr.prompt(paneId, 'yes').pipe(Effect.flip))._tag, 'Permanent');
			assert.deepStrictEqual(fake.starts(), [
				{ paneId, name: 'hl-5', prompt: 'Work on HL-5. Go.' },
				{ paneId: other.paneId, name: 'hl-6', prompt: 'Work on HL-6.' },
			]);
			assert.deepStrictEqual(fake.sentKeys(), [{ paneId, keys: ['esc'] }]);
			assert.deepStrictEqual(fake.prompts(), [{ paneId, text: 'continue' }]);
			assert.deepStrictEqual(Option.map(fake.tab(tabId), ({ label }) => label), Option.some('HL-5 Sync'));
		}),
	);

	it.effect('fails the nth write without applying it, or after applying it', () =>
		Effect.gen(function* () {
			const [herdr, fake] = yield* fakeHerdr;
			const transient = new Transient({ message: 'herdr timed out' });

			// The workspace is created (write 1); renaming its tab (write 2) fails.
			fake.failWrite(2, transient);
			assert.deepStrictEqual(yield* herdr.openTab('HL-7 Crash', '/work/hl-7').pipe(Effect.flip), transient);
			assert.deepStrictEqual(
				fake.tabs().map(({ label }) => label),
				['1'],
			);

			const { tabId } = fake.addTab({ label: 'HL-8 Done' });

			fake.crashAfterWrite(1, transient);
			assert.deepStrictEqual(yield* herdr.closeTab(tabId).pipe(Effect.flip), transient);
			assert.deepStrictEqual(fake.closedTabs(), [tabId]);
			assert.isFalse(yield* herdr.closeTab(tabId));
		}),
	);

	it.effect('reads the tail and tells a removed tab or exited agent apart', () =>
		Effect.gen(function* () {
			const [herdr, fake] = yield* fakeHerdr;
			const { tabId, paneId } = fake.addTab({ label: 'HL-9 Tail', tail: 'one\n\n\n\ntwo\nthree\n' });

			assert.deepStrictEqual(yield* herdr.readTail(paneId), Option.some('one\n\ntwo\nthree'));
			assert.deepStrictEqual(yield* herdr.readTail(paneId, 3), Option.some('two\nthree'));

			fake.setAgent(paneId, null);
			assert.deepStrictEqual(yield* herdr.agent(paneId), Option.none());
			assert.isTrue(Option.isSome(yield* herdr.pane(paneId)));

			fake.removeTab(tabId);
			assert.deepStrictEqual(yield* herdr.pane(paneId), Option.none());
			assert.deepStrictEqual(yield* herdr.readTail(paneId), Option.none());
		}),
	);

	it.effect('reconnects after a disconnect with growing backoff, and loses events sent meanwhile', () =>
		Effect.gen(function* () {
			const [herdr, fake] = yield* fakeHerdr;
			const received = yield* Queue.unbounded<HerdrEvent>();
			const exited = (paneId: string): HerdrEvent => ({ _tag: 'PaneExited', paneId });

			yield* Effect.forkScoped(Stream.runForEach(herdr.events, (event) => Queue.offer(received, event)));
			yield* fake.awaitConnections(1);
			yield* fake.emit(exited('w1:p1'));
			assert.deepStrictEqual(yield* Queue.take(received), exited('w1:p1'));

			yield* fake.disconnect;
			yield* fake.emit(exited('w1:p2'));
			yield* TestClock.adjust('999 millis');
			assert.strictEqual(yield* fake.connections, 1);
			yield* TestClock.adjust('1 millis');
			assert.strictEqual(yield* fake.connections, 2);

			// Without an event in between, the next delay doubles.
			yield* fake.disconnect;
			yield* TestClock.adjust('1999 millis');
			assert.strictEqual(yield* fake.connections, 2);
			yield* TestClock.adjust('1 millis');
			assert.strictEqual(yield* fake.connections, 3);

			yield* fake.emit(exited('w1:p3'));
			assert.deepStrictEqual(yield* Queue.take(received), exited('w1:p3'));
			assert.isTrue(Option.isNone(yield* Queue.poll(received)));
		}),
	);
});
