import { z } from 'zod';

// The only contract between the dispatcher and a worker. Messages are plain JSON so a remote worker
// can later exchange them over a WebSocket without either side changing.

export const runSchema = z.object({
	tabId: z.string(),
	paneId: z.string(),
	worktreePath: z.string(),
	branch: z.string(),
	githubRepo: z.string(),
});

export type Run = z.infer<typeof runSchema>;

export const jobSchema = z.object({
	epicId: z.string(),
	identifier: z.string(),
	branch: z.string(),
	repoPath: z.string(),
	tabLabel: z.string(),
	prompt: z.string(),
});

export type Job = z.infer<typeof jobSchema>;

export const agentStatusSchema = z.enum(['working', 'idle', 'done', 'blocked', 'unknown']);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

// What the agent writes as the last step of a run. A valid file is the run's completion signal.
export const resultFileSchema = z.strictObject({
	summary: z.string().min(1),
	replies: z.array(z.strictObject({ threadId: z.string().min(1), body: z.string().min(1) })),
	flags: z.array(z.strictObject({ path: z.string().min(1), line: z.number().int().min(1), body: z.string().min(1) })),
});

export type ResultFile = z.infer<typeof resultFileSchema>;

export const dispatcherMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('dispatch'), job: jobSchema }),
	// Re-attach to a run after a dispatcher restart. Without a run, the dispatch was interrupted before
	// the worker confirmed it, so the worker looks for the job's tab instead.
	z.object({ type: z.literal('watch'), job: jobSchema, run: runSchema.optional() }),
	// The run is over: stop watching it and close its tab.
	z.object({ type: z.literal('close'), job: jobSchema, run: runSchema }),
	// The epic shipped or its PR was merged or closed: close the tab, then remove the worktree and local branch
	// unless they hold work that is not on origin.
	z.object({ type: z.literal('cleanup'), job: jobSchema, run: runSchema }),
	// The agent shows no progress: press Esc, then prompt it to continue.
	z.object({ type: z.literal('nudge'), job: jobSchema, run: runSchema }),
	// The user answered the agent's question on Linear: type the answer into the pane.
	z.object({ type: z.literal('reply'), job: jobSchema, run: runSchema, commentId: z.string(), text: z.string() }),
]);

export type DispatcherMessage = z.infer<typeof dispatcherMessageSchema>;

export const workerMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('started'), epicId: z.string(), run: runSchema }),
	z.object({ type: z.literal('status'), epicId: z.string(), status: agentStatusSchema, tail: z.string() }),
	z.object({
		type: z.literal('finished'),
		epicId: z.string(),
		reason: z.enum(['exited', 'vanished']),
		tail: z.string(),
	}),
	z.object({ type: z.literal('failed'), epicId: z.string(), error: z.string(), tail: z.string().optional() }),
	z.object({ type: z.literal('cleaned'), epicId: z.string() }),
	z.object({ type: z.literal('kept'), epicId: z.string(), worktreePath: z.string(), reason: z.string() }),
	z.object({ type: z.literal('result'), epicId: z.string(), result: resultFileSchema }),
	z.object({ type: z.literal('invalidResult'), epicId: z.string(), error: z.string() }),
	z.object({ type: z.literal('replyFailed'), epicId: z.string(), commentId: z.string(), error: z.string() }),
]);

export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export type Send<T> = (message: T) => void;
