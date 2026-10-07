import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Schema } from 'effect';
import { allowToolUse, ClaudeRunHook, denyToolUse } from './claude-hooks.ts';
import { env, loadSettings } from './config.ts';
import { journalPath, readProjects } from './journal.ts';
import { bashRefusal, commandToolDecision, type DispatchedRun, fileWriteRefusal, isCommandCwd, isProjectRepo, worktreeOf } from './run-guards.ts';


const refusal = (run: DispatchedRun, hook: ClaudeRunHook) => {
	if (!('toolInput' in hook)) {
		return undefined;
	}

	if ('command' in hook.toolInput) {
		return bashRefusal(hook.cwd, hook.toolInput.command);
	}

	return fileWriteRefusal(run, hook.cwd, 'filePath' in hook.toolInput ? hook.toolInput.filePath : hook.toolInput.notebookPath);
};

// The run's agent's or a subagent's tool call: what the hook prints to refuse it, if it is refused.
const guardToolUse = (run: DispatchedRun, hook: ClaudeRunHook) => Option.map(Option.fromUndefinedOr(refusal(run, hook)), denyToolUse);

// A command thread's tool call: allowed without asking, or refused.
const guardCommandToolUse = (hook: ClaudeRunHook) => {
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

// What the hook prints for a Claude PreToolUse payload: in a command thread, whether the tool call may run; in a
// dispatched run, a refused tool call. Elsewhere: nothing.
export const runHookAnswer = (payload: string) =>
	Effect.gen(function* () {
		const hook = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeRunHook))(payload);

		if (isCommandCwd(yield* env.stateDirectory, hook.cwd)) {
			return Option.some(guardCommandToolUse(hook));
		}

		const run = yield* dispatchedRun(hook.cwd);

		return run === undefined ? Option.none<string>() : guardToolUse(run, hook);
	});

export const answerRunHook = (payload: string) => Effect.runPromise(runHookAnswer(payload).pipe(Effect.map(Option.getOrUndefined), Effect.provide(NodeServices.layer)));
