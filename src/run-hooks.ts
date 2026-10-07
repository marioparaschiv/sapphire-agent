import { basename } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { allowToolUse, ClaudeRunHook, denyToolUse } from './claude-hooks.ts';
import { env, loadSettings, PushoverConfig } from './config.ts';
import { journalPath, readProjects } from './journal.ts';
import { Linear } from './linear.ts';
import { Pushover } from './pushover.ts';
import { bashRefusal, commandToolDecision, currentBranch, type DispatchedRun, epicIdentifier, fileWriteRefusal, isCommandCwd, isProjectRepo, worktreeOf } from './run-guards.ts';

type ToolUse = Extract<ClaudeRunHook, { readonly hookEventName: 'PreToolUse' }>;

type RunEnd = Exclude<ClaudeRunHook, ToolUse>;

const refusal = (run: DispatchedRun, hook: ToolUse) => {
	if (!('toolInput' in hook)) {
		return undefined;
	}

	if ('command' in hook.toolInput) {
		return bashRefusal(hook.cwd, hook.toolInput.command);
	}

	return fileWriteRefusal(run, hook.cwd, 'filePath' in hook.toolInput ? hook.toolInput.filePath : hook.toolInput.notebookPath);
};

// The run's agent's or a subagent's tool call: what the hook prints to refuse it, if it is refused.
const guardToolUse = (run: DispatchedRun, hook: ToolUse) => Option.map(Option.fromUndefinedOr(refusal(run, hook)), denyToolUse);

// One Pushover notice that the run's agent finished its turn or waits for input, linked to the epic in Linear when
// the branch names one. A subagent's turn sends nothing.
export const sendRunNotice = (run: DispatchedRun, hook: RunEnd) =>
	Effect.gen(function* () {
		if (hook.agentId !== undefined) {
			return;
		}

		const linear = yield* Linear;
		const pushover = yield* Pushover;
		const branch = currentBranch(run.worktree) ?? basename(run.worktree);
		const identifier = epicIdentifier(branch);
		const name = identifier ?? branch;
		const where = `${run.repoName} on ${branch}`;
		const url =
			identifier === undefined
				? undefined
				: yield* linear.epicsByIdentifier([identifier]).pipe(
						Effect.map((epics) => epics[0]?.url),
						Effect.catch((error) => Effect.logWarning(`cannot look up ${identifier} in Linear; the notice goes without its link`, error).pipe(Effect.as(undefined))),
					);

		yield* pushover.send({
			title: hook.hookEventName === 'Stop' ? `${name} finished its turn` : `${name} needs input`,
			message: hook.hookEventName === 'Stop' ? where : `${hook.message}\n${where}`,
			priority: 'normal',
			...(url === undefined ? {} : { url }),
		});
	});

const noticeLayer = Layer.mergeAll(Linear.layer(), Pushover.layer()).pipe(Layer.provide(PushoverConfig.layerWithAppConfig), Layer.provide(FetchHttpClient.layer));

// A command thread's tool call: allowed without asking, or refused.
const guardCommandToolUse = (hook: ToolUse) => {
	const { allow, reason } = commandToolDecision(hook.toolName, 'toolInput' in hook && 'command' in hook.toolInput ? hook.toolInput.command : undefined);

	return allow ? allowToolUse(reason) : denyToolUse(reason);
};

// The run whose worktree `cwd` is in. The journal is read only for a checkout under the worktrees directory.
const dispatchedRun = (cwd: string) =>
	Effect.gen(function* () {
		const run = worktreeOf((yield* loadSettings).worktreesDirectory, cwd);

		if (run === undefined) {
			return undefined;
		}

		return isProjectRepo(yield* readProjects(journalPath(yield* env.stateDirectory)), run.repoName) ? run : undefined;
	});

// What the hook prints for a Claude PreToolUse, Stop or Notification payload: in a command thread, whether its tool call
// may run; in a dispatched run, a refused tool call. Elsewhere, and for a command thread's other events: nothing.
export const runHookAnswer = (payload: string) =>
	Effect.gen(function* () {
		const hook = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeRunHook))(payload);

		if (isCommandCwd(yield* env.stateDirectory, hook.cwd)) {
			return hook.hookEventName === 'PreToolUse' ? Option.some(guardCommandToolUse(hook)) : Option.none<string>();
		}

		const run = yield* dispatchedRun(hook.cwd);

		if (run === undefined) {
			return Option.none<string>();
		}

		if (hook.hookEventName === 'PreToolUse') {
			return guardToolUse(run, hook);
		}

		yield* sendRunNotice(run, hook).pipe(Effect.provide(noticeLayer));

		return Option.none<string>();
	});

export const answerRunHook = (payload: string) => Effect.runPromise(runHookAnswer(payload).pipe(Effect.map(Option.getOrUndefined), Effect.provide(NodeServices.layer)));
