import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock, Effect, Option } from 'effect';
import { Permanent } from './call-policy.ts';
import { ClaudeTrust } from './claude-trust.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { describeAgent, runsClaude, sessionClaudeArgs } from './dispatch.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { Herdr } from './herdr.ts';
import { type Command, commandIdentifier, type CommandStatus, Journal, newSession } from './journal.ts';
import { isSameWatch, quietStatuses, tailHash, trackAgent } from './monitoring.ts';
import { type Observation, observedAgentStatus } from './observation.ts';
import type { Rule, TaskWork } from './planner.ts';
import { Prompts } from './prompts.ts';
import { makeNudge } from './run-actions.ts';

export const ctlPath = fileURLToPath(new URL('../scripts/ctl.sh', import.meta.url));

// Read-only gh and git subcommands a command's agent may run, besides the CLI. `--output` would make git write a file.
const readOnlyCommands = ['gh pr view', 'gh pr diff', 'gh pr checks', 'gh issue view', 'git log', 'git show', 'git diff', 'git status'];

// The commands whose comment still gets a thumbs-up when it has none: an ignored one never does, and one that ended
// or failed has had its answer.
const acknowledgedStatuses: ReadonlyArray<CommandStatus> = ['queued', 'claimed', 'running'];

// The tools besides Bash, each allowed in full.
const allowedTools = ['Read', 'Grep', 'Glob', 'SendMessage'];

// What Claude is started with for a command. --restricted ignores the user's and the project's settings, which may allow
// more or bypass permissions, and keeps the file tools in the working directory; --tools leaves no tool that edits, and
// SendMessage to message a run's session; dontAsk denies, without asking, every Bash command the allow list does not
// cover, a command chained onto an allowed one included.
export const commandClaudeArgs = (ctl: string) => [
	'--restricted',
	'--strict-mcp-config',
	'--tools',
	['Bash', ...allowedTools].join(','),
	'--settings',
	JSON.stringify({
		permissions: {
			defaultMode: 'dontAsk',
			allow: [`Bash(sh ${ctl} *)`, ...readOnlyCommands.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]), ...allowedTools],
			deny: ['Bash(git * --output*)'],
		},
	}),
];

const minutes = (millis: number) => Math.round(millis / 60_000);

// Runs the command agents, one at a time, oldest first, and posts what they ask to post. A command's turn starts it in
// a herdr tab in the local clone of the repo its comment is on: tab, Claude with the command prompt, then running. A
// running command ends once its agent said it was done (`ctl.sh done`) and stopped working. It fails, with a reply as
// the bot on the issue or PR it came from and its tab closed, when it does not start in time, its agent exits, sits
// quiet for awaitingInputAfterSeconds, stays stale after a nudge, or runs past maxRunSeconds. Not paused: `resume`
// itself comes in as a command.
export const commandsRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const git = yield* Git;
	const github = yield* GitHub;
	const herdr = yield* Herdr;
	const trust = yield* ClaudeTrust;
	const prompts = yield* Prompts;
	const comments = yield* Comments;
	const nudge = yield* makeNudge;
	// After a restart a claimed command gets a full start window again.
	const bootedAt = yield* Clock.currentTimeMillis;
	const { env } = config;
	// So the agent's `ctl.sh` reaches this journal and config, wherever the service keeps them.
	const tabEnv = {
		HERDR_BIN_PATH: env.herdrBinPath,
		HERDR_SOCKET_PATH: env.herdrSocketPath,
		HERDR_PLUGIN_CONFIG_DIR: env.configDirectory,
		HERDR_PLUGIN_STATE_DIR: env.stateDirectory,
		SAPPHIRE_AGENT_LINEAR_KEY_FILE: env.linearKeyFile,
		CLAUDE_CONFIG_PATH: env.claudeConfigPath,
	};

	// A configured clone whose origin is the comment's repo; the state directory when there is none, so status, pause
	// and the like still work.
	const cwdOf = (repo: string) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const name = basename(repo);
			const candidates = new Set([
				...Object.values(config.teams).flatMap((team) => [team.repo, ...(team.labelReposDirectory ? [join(team.labelReposDirectory, name)] : [])]),
				...runs.map((run) => run.repo),
			]);

			for (const candidate of candidates) {
				const origin = yield* git.githubRepo(candidate).pipe(Effect.option);

				if (Option.exists(origin, (found) => found.toLowerCase() === repo.toLowerCase())) {
					return candidate;
				}
			}

			return env.stateDirectory;
		});

	// The workspace of the team whose repo the command runs in, or workspaceLabel for a repo of no team.
	const workspaceOf = (cwd: string) =>
		Object.entries(config.teams).find(([, team]) => team.repo === cwd || team.labelReposDirectory === dirname(cwd))?.[0] ?? config.workspaceLabel;

	// The notice goes first, keyed by the claim, so a crash before the journal records it never posts it twice.
	const fail = (command: Command, reason: string, tail: Option.Option<string>) =>
		Effect.gen(function* () {
			const identifier = commandIdentifier(command);

			yield* Effect.logError(`${reason}; failing it`);
			yield* github
				.postComment(command.repo, command.number, comments.commandFailed({ identifier, claimedAt: command.claimedAt ?? command.recordedAt, reason, tail }))
				.pipe(Effect.catchTag('Permanent', (error) => Effect.logError(`cannot tell ${command.url} that ${identifier} failed`, error)));
			yield* closeTab(command);
			yield* journal.putCommand({ ...command, status: 'error' });
		});

	// Looked up in herdr rather than the observation, which does not have a tab opened this tick. Matched by tab and pane
	// id, as a run's tab is.
	const closeTab = ({ tabId, paneId }: Command) =>
		tabId === null || paneId === null
			? Effect.void
			: herdr
					.pane(paneId)
					.pipe(
						Effect.flatMap((pane) =>
							Option.exists(pane, (found) => found.tabId === tabId) ? herdr.closeTab(tabId).pipe(Effect.andThen(Effect.log(`closed tab ${tabId}`))) : Effect.void,
						),
					);

	const readTail = (command: Command) => (command.paneId === null ? Effect.succeedNone : herdr.readTail(command.paneId));

	const start = (observation: Observation, commands: ReadonlyArray<Command>, next: Command) =>
		Effect.gen(function* () {
			const identifier = commandIdentifier(next);
			const now = yield* Clock.currentTimeMillis;
			let command = next;

			if (command.claimedAt === null) {
				command = { ...command, status: 'claimed', claimedAt: now, session: yield* newSession(identifier) };
				yield* journal.putCommand(command);
				yield* Effect.log(`claimed for ${command.url}`);
			} else if (now - Math.max(command.claimedAt, bootedAt) >= config.startTimeoutSeconds * 1000) {
				return yield* fail(command, `was not confirmed running within ${config.startTimeoutSeconds} s`, yield* readTail(command));
			}

			const openTab = (cwd: string) =>
				Effect.gen(function* () {
					const label = prompts.commandTabLabel({ identifier });
					const found = Option.fromUndefinedOr(
						observation.tabs.find((tab) => tab.label === label && !commands.some((other) => other.tabId === tab.tabId || other.paneId === tab.paneId)),
					);
					// The observation is from the start of the tick; an earlier rule may have closed the tab since.
					const live = Option.isSome(found) && Option.isSome(yield* herdr.pane(found.value.paneId)) ? found : Option.none();
					const tab = yield* Option.match(live, {
						onNone: () => herdr.openTab(workspaceOf(cwd), label, cwd, tabEnv),
						onSome: (adopted) => Effect.log(`adopting tab ${adopted.tabId}`).pipe(Effect.as(adopted)),
					});

					command = { ...command, tabId: tab.tabId, paneId: tab.paneId };
					yield* journal.putCommand(command);

					return tab;
				});

			const steps = Effect.gen(function* () {
				const cwd = command.cwd ?? (yield* cwdOf(command.repo));

				if (command.cwd === null) {
					command = { ...command, cwd };
					yield* journal.putCommand(command);
				}

				yield* trust.trustFolder(cwd);

				const { tabId, paneId } = command.tabId !== null && command.paneId !== null ? { tabId: command.tabId, paneId: command.paneId } : yield* openTab(cwd);

				if (!runsClaude(yield* herdr.agent(paneId))) {
					yield* Effect.log(`starting Claude in ${tabId} (${cwd})`);
					yield* herdr.startClaude(
						paneId,
						identifier.toLowerCase(),
						prompts.command({ identifier, author: command.author, url: command.url, repo: command.repo, number: command.number, body: command.body, ctl: ctlPath }),
						[...commandClaudeArgs(ctlPath), ...sessionClaudeArgs(command.session)],
					);

					const agent = yield* herdr.agent(paneId);

					if (!runsClaude(agent) || Option.exists(agent, (found) => found.agentStatus === 'blocked')) {
						return yield* new Permanent({ message: `Claude did not start in ${tabId}: ${describeAgent(agent)}` });
					}
				}

				command = { ...command, status: 'running', startedAt: yield* Clock.currentTimeMillis };
				yield* journal.putCommand(command);
				yield* Effect.log(`agent started in tab ${tabId}`);
			});

			yield* steps.pipe(Effect.catchTag('Permanent', (error) => readTail(command).pipe(Effect.flatMap((tail) => fail(command, `could not start: ${error.message}`, tail)))));
		});

	// Closing a working agent's tab would cut its turn short, so a command that is done ends once its agent stopped.
	const watch = (observation: Observation, watched: Command, done: ReadonlyArray<number>) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const status = observedAgentStatus(observation, watched);

			if (done.length > 0 && status !== 'working') {
				yield* closeTab(watched);
				yield* journal.putCommand({ ...watched, status: 'ended' });
				yield* Effect.forEach(done, journal.deleteRequest, { discard: true });

				return yield* Effect.log('the agent is done; ended the command');
			}

			const tail = status === 'vanished' ? Option.none<string>() : yield* readTail(watched);
			let command = trackAgent(watched, status, tailHash(Option.getOrElse(tail, () => '')), now).tracked;

			if (!isSameWatch(watched, command)) {
				yield* journal.putCommand(command);
			}

			const ranFor = now - (command.claimedAt ?? now);
			const since = command.agentStatusSince ?? now;

			if (ranFor >= config.maxRunSeconds * 1000) {
				return yield* fail(command, `ran for ${minutes(ranFor)} min, over the ${minutes(config.maxRunSeconds * 1000)} min cap`, tail);
			}

			if (status === 'exited' || status === 'vanished') {
				return yield* fail(command, status === 'exited' ? 'exited' : 'disappeared (its tab was closed or herdr restarted)', tail);
			}

			if (quietStatuses.includes(status) && now - since >= config.awaitingInputAfterSeconds * 1000) {
				return yield* fail(command, `stopped ${minutes(now - since)} min ago without saying it was done`, tail);
			}

			const { paneId } = command;

			if (status !== 'working' || paneId === null) {
				return;
			}

			if (command.nudgedAt === null) {
				if (now - since >= config.staleAfterSeconds * 1000) {
					command = { ...command, nudgedAt: now };
					yield* journal.putCommand(command);
					yield* nudge(paneId);
				}

				return;
			}

			if (now - command.nudgedAt >= config.nudgeGraceSeconds * 1000) {
				yield* fail(command, `showed no new output for ${minutes(now - since)} min, even after a nudge`, tail);
			}
		});

	const postReply = (command: Command, requestId: number, body: string) =>
		github.postComment(command.repo, command.number, comments.commandReply({ identifier: commandIdentifier(command), requestId, body })).pipe(
			Effect.andThen(Effect.log(`replied on ${command.url}`)),
			Effect.catchTag('Permanent', (error) => Effect.logError(`cannot reply on ${command.url}; dropped request ${requestId}`, error)),
			Effect.andThen(journal.deleteRequest(requestId)),
		);

	// A thumbs-up on the comment tells its author the bot has it, before any reply. One that fails for now is tried again
	// next tick without holding up the command; one that cannot be given is not tried again.
	const acknowledge = (command: Command) =>
		github.addThumbsUp(command.repo, command.commentId).pipe(
			Effect.andThen(Effect.log(`gave ${command.url} a thumbs-up`)),
			Effect.catchTag('Permanent', (error) => Effect.logError(`cannot give ${command.url} a thumbs-up`, error)),
			Effect.andThen(Clock.currentTimeMillis),
			Effect.map((now): Command => ({ ...command, acknowledgedAt: now })),
			Effect.tap(journal.putCommand),
			Effect.catchTag('Transient', (error) => Effect.logWarning(`cannot give ${command.url} a thumbs-up yet; trying again next tick`, error).pipe(Effect.as(command))),
		);

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const commands = yield* journal.listCommands;
			const requests = (yield* journal.listRequests).flatMap(({ id, request }) => ('commandId' in request ? [{ id, request }] : []));
			const running = commands.some((command) => command.status === 'running');
			const next = commands.find((command) => command.status === 'claimed') ?? (running ? undefined : commands.find((command) => command.status === 'queued'));
			const work: Array<TaskWork> = [];

			for (const listed of commands) {
				const own = requests.filter(({ request }) => request.commandId === listed.id);
				const replies = own.flatMap(({ id, request }) => (request._tag === 'reply' ? [postReply(listed, id, request.body)] : []));
				const done = own.flatMap(({ id, request }) => (request._tag === 'done' ? [id] : []));
				const unacknowledged = listed.acknowledgedAt === null && acknowledgedStatuses.includes(listed.status);
				// Given the command as acknowledged, so its own write keeps acknowledgedAt.
				const lifecycle =
					listed.status === 'running'
						? Option.some((command: Command) => watch(observation, command, done))
						: listed === next
							? Option.some((command: Command) => start(observation, commands, command))
							: // A done request outlives its command only when a crash came between ending it and dropping the request.
								Option.some(() => Effect.forEach(done, journal.deleteRequest, { discard: true })).pipe(Option.filter(() => done.length > 0));

				if (!unacknowledged && replies.length === 0 && Option.isNone(lifecycle)) {
					continue;
				}

				work.push({
					task: commandIdentifier(listed),
					apply: Effect.gen(function* () {
						const command = unacknowledged ? yield* acknowledge(listed) : listed;

						yield* Effect.all(replies, { discard: true });

						if (Option.isSome(lifecycle)) {
							yield* lifecycle.value(command);
						}
					}).pipe(
						// Only what cannot be helped fails a command; the rest is tried again next tick.
						Effect.catchTag('Transient', (error) => Effect.logWarning('failed; retrying next tick', error)),
					),
				});
			}

			for (const { id, request } of requests) {
				if (!commands.some((command) => command.id === request.commandId)) {
					work.push({ task: `request ${id}`, apply: journal.deleteRequest(id).pipe(Effect.andThen(Effect.log(`no command CMD-${request.commandId}; dropped request ${id}`))) });
				}
			}

			return work;
		});

	return { name: 'commands', pausable: false, plan } satisfies Rule;
});
