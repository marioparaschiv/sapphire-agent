import { basename, join } from 'node:path';
import { Clock, Effect, FileSystem, Option } from 'effect';
import { fileSystemFailure, Permanent } from './call-policy.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { commandsDirectory, ctlPath } from './directories.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { type Command, commandIdentifier, type CommandStatus, Journal } from './journal.ts';
import type { Rule, TaskWork } from './planner.ts';
import { Projects } from './projects.ts';
import { Prompts } from './prompts.ts';
import { makeInterrupt, makeSettle } from './run-actions.ts';
import { hasActiveRun, hasFailedRun, T3 } from './t3.ts';
import { T3Projects } from './t3-projects.ts';

// The commands whose comment still gets a thumbs-up when it has none: an ignored one never does, and one that ended
// or failed has had its answer.
const acknowledgedStatuses: ReadonlyArray<CommandStatus> = ['queued', 'claimed', 'running'];

const minutes = (millis: number) => Math.round(millis / 60_000);

type ThreadedCommand = Command & { readonly threadId: string };

// Runs the command agents, one at a time, oldest first, and posts what they ask to post. A command's turn launches a
// supervised T3 thread titled `CMD-<n>` with the command prompt, in a checkout of the comment's repo at origin's
// default branch under the state directory's `commands` (or that directory itself without a clone), where the
// PreToolUse guard keeps it to reading (`run-guards.ts`); then running. A running command ends once its agent said it
// was done (`ctl.sh done`) and its thread stopped; its thread is settled. It fails, with a reply as the bot on the issue
// or PR it came from and its thread interrupted and settled, when it does not start in time, its thread is gone, sits
// quiet for awaitingInputAfterSeconds, or runs past maxRunSeconds. Not paused: `resume` itself comes in as a command.
export const commandsRule = Effect.gen(function* () {
	const config = yield* AppConfig;
	const journal = yield* Journal;
	const projects = yield* Projects;
	const git = yield* Git;
	const github = yield* GitHub;
	const prompts = yield* Prompts;
	const comments = yield* Comments;
	const t3 = yield* T3;
	const t3Projects = yield* T3Projects;
	const interrupt = yield* makeInterrupt;
	const settle = yield* makeSettle;
	const fs = yield* FileSystem.FileSystem;
	// After a restart a claimed command gets a full start window again.
	const bootedAt = yield* Clock.currentTimeMillis;
	const { env } = config;

	// A project's clone whose origin is the comment's repo.
	const cloneOf = (repo: string) =>
		Effect.gen(function* () {
			const runs = yield* journal.listRuns;
			const name = basename(repo);
			const candidates = new Set([
				...(yield* projects.list).flatMap((project) => [project.repo, ...(project.labelReposDirectory === null ? [] : [join(project.labelReposDirectory, name)])]),
				...runs.map((run) => run.repo),
			]);

			for (const candidate of candidates) {
				const origin = yield* git.githubRepo(candidate).pipe(Effect.option);

				if (Option.exists(origin, (found) => found.toLowerCase() === repo.toLowerCase())) {
					return Option.some(candidate);
				}
			}

			return Option.none<string>();
		});

	// Its thread is stopped and settled.
	const stop = (command: Command, reason: string) =>
		command.threadId === null
			? Effect.void
			: interrupt(command, reason, `fail-${commandIdentifier(command)}`).pipe(Effect.andThen(settle(command.threadId)));

	// The reply goes first, keyed by the claim, so a crash before the journal records it never posts it twice.
	const fail = (command: Command, reason: string) =>
		Effect.gen(function* () {
			const identifier = commandIdentifier(command);

			yield* Effect.logError(`${reason}; failing it`);
			yield* github
				.postComment(command.repo, command.number, comments.commandFailed({ identifier, claimedAt: command.claimedAt ?? command.recordedAt, reason }))
				.pipe(Effect.catchTag('Permanent', (error) => Effect.logError(`cannot tell ${command.url} that ${identifier} failed`, error)));
			yield* stop(command, reason);
			yield* journal.putCommand({ ...command, status: 'error' });
		});

	const start = (next: Command) =>
		Effect.gen(function* () {
			const identifier = commandIdentifier(next);
			const now = yield* Clock.currentTimeMillis;
			let command = next;

			if (command.claimedAt === null) {
				command = { ...command, status: 'claimed', claimedAt: now };
				yield* journal.putCommand(command);
				yield* Effect.log(`claimed for ${command.url}`);
			} else if (now - Math.max(command.claimedAt, bootedAt) >= config.startTimeoutSeconds * 1000) {
				return yield* fail(command, `was not confirmed running within ${config.startTimeoutSeconds} s`);
			}

			const promptOf = () => prompts.command({ identifier, author: command.author, url: command.url, repo: command.repo, number: command.number, body: command.body, ctl: ctlPath });

			// The thread is recorded before anything else, so a crash after the launch never launches a second one; one
			// launched just before a crash is found by its title.
			const steps = Effect.gen(function* () {
				if (command.threadId === null) {
					const clone = yield* cloneOf(command.repo);
					const directory = commandsDirectory(env.stateDirectory);
					const cwd = Option.match(clone, { onNone: () => directory, onSome: (found) => join(directory, basename(found)) });

					yield* Option.match(clone, {
						onNone: () => fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.mapError(fileSystemFailure)),
						onSome: (found) => git.checkoutDefaultBranch(found, cwd),
					});

					if (command.cwd !== cwd) {
						command = { ...command, cwd };
						yield* journal.putCommand(command);
					}

					const projectId = yield* t3Projects.projectFor(Option.getOrElse(clone, () => cwd));
					const found = (yield* t3.listThreads({ projectId, titleContains: identifier, includeSubagents: false })).find((thread) => thread.title === identifier);
					const launched =
						found === undefined
							? yield* t3.launchThread({
									projectId,
									title: identifier,
									message: promptOf(),
									workspaceStrategy: Option.isSome(clone) ? { type: 'existing_worktree', worktreePath: cwd } : { type: 'root' },
									runtimeMode: 'approval-required',
								})
							: { threadId: found.threadId, status: found.status };

					command = { ...command, threadId: launched.threadId };
					yield* journal.putCommand(command);

					if (hasFailedRun(launched.status)) {
						return yield* new Permanent({ message: `the run of T3 thread ${launched.threadId} ended at once: ${launched.status}` });
					}
				}

				command = { ...command, status: 'running', startedAt: yield* Clock.currentTimeMillis };
				yield* journal.putCommand(command);
				yield* Effect.log(`agent started in T3 thread ${command.threadId}`);
			}).pipe(Effect.catchTag('T3ToolFailure', (error) => Effect.fail(new Permanent({ message: `T3 refused ${error.tool}: ${error.message} (${error.code})` }))));

			yield* steps.pipe(Effect.catchTag('Permanent', (error) => fail(command, `could not start: ${error.message}`)));
		});

	// A thread that stopped (or never ran) is quiet; one waiting on the user's approval or answer is not.
	const watch = (command: ThreadedCommand, done: ReadonlyArray<number>) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const read = yield* t3.readThread({ threadId: command.threadId, limit: 1 }).pipe(
				Effect.map(Option.some),
				Effect.catchTag('T3ToolFailure', (error) => (error.code === 'thread_not_found' ? Effect.succeedNone : Effect.fail(error))),
			);

			if (Option.isNone(read)) {
				return yield* fail(command, 'lost its T3 thread');
			}

			const { status, updatedAt, pendingRequestCount } = read.value.thread;
			const working = hasActiveRun(status);

			if (done.length > 0 && !working) {
				yield* settle(command.threadId);
				yield* journal.putCommand({ ...command, status: 'ended' });
				yield* Effect.forEach(done, journal.deleteRequest, { discard: true });

				return yield* Effect.log('the agent is done; ended the command');
			}

			const ranFor = now - (command.claimedAt ?? now);
			const quietFor = now - Date.parse(updatedAt);

			if (ranFor >= config.maxRunSeconds * 1000) {
				return yield* fail(command, `ran for ${minutes(ranFor)} min, over the ${minutes(config.maxRunSeconds * 1000)} min cap`);
			}

			if (!working && pendingRequestCount === 0 && quietFor >= config.awaitingInputAfterSeconds * 1000) {
				yield* fail(command, `stopped ${minutes(quietFor)} min ago without saying it was done`);
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

	const plan = () =>
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
						? Option.some((command: Command) => (command.threadId === null ? fail(command, 'lost its T3 thread') : watch({ ...command, threadId: command.threadId }, done)))
						: listed === next
							? Option.some(start)
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
