import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Schema } from 'effect';
import { allowToolUse, ClaudeRunHook, claudeToolCall, denyToolUse } from './claude-hooks.ts';
import { env, loadSettings } from './config.ts';
import { journalPath, readProjects } from './journal.ts';
import { commandToolDecision, isCommandCwd, isProjectRepo, type ToolCall, type ToolDecision, toolRefusal, worktreeOf } from './run-guards.ts';

// The run whose worktree `cwd` is in, and the directories that hold checkouts: the worktrees directory and the
// projects' repos. The journal is read only for a checkout under the worktrees directory.
const dispatchedRun = (cwd: string) =>
	Effect.gen(function* () {
		const { worktreesDirectory } = yield* loadSettings;
		const run = worktreeOf(worktreesDirectory, cwd);

		if (run === undefined) {
			return undefined;
		}

		const projects = yield* readProjects(journalPath(yield* env.stateDirectory));
		const checkouts = [worktreesDirectory, ...projects.flatMap(({ repo, labelReposDirectory }) => (labelReposDirectory === null ? [repo] : [repo, labelReposDirectory]))];

		return isProjectRepo(projects, run.repoName) ? { run, checkouts } : undefined;
	});

// What the guards decide about an agent's tool call in `cwd`, whichever agent makes it: in a command thread, whether it
// may run; in a dispatched run, a refusal, for the run's agent and its subagents alike. Elsewhere: nothing.
export const toolCallDecision = (cwd: string, call: ToolCall) =>
	Effect.gen(function* () {
		if (isCommandCwd(yield* env.stateDirectory, cwd)) {
			return Option.some(commandToolDecision(call));
		}

		const dispatched = yield* dispatchedRun(cwd);
		const refusal = dispatched === undefined ? undefined : toolRefusal(dispatched.run, cwd, call, dispatched.checkouts);

		return Option.map(Option.fromUndefinedOr(refusal), (reason): ToolDecision => ({ allow: false, reason }));
	});

// What the hook prints for a Claude PreToolUse payload: the guards' decision, if they make one.
export const runHookAnswer = (payload: string) =>
	Effect.gen(function* () {
		const hook = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeRunHook))(payload);
		const decision = yield* toolCallDecision(hook.cwd, claudeToolCall(hook));

		return Option.map(decision, ({ allow, reason }) => (allow ? allowToolUse(reason) : denyToolUse(reason)));
	});

const runWithNode = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

export const answerRunHook = (payload: string) => runWithNode(runHookAnswer(payload).pipe(Effect.map(Option.getOrUndefined)));

// For the Pi extension, which guards its tool calls in its own process.
export const decideToolCall = (cwd: string, call: ToolCall) => runWithNode(toolCallDecision(cwd, call).pipe(Effect.map(Option.getOrUndefined)));
