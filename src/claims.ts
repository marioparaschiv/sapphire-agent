import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.ts';
import { agentStatusSchema, jobSchema, resultFileSchema, runSchema } from './protocol.ts';

// claimed: recorded before the dispatch is sent. running: the worker confirmed the agent started.
// awaitingInput: the agent sat idle or blocked without a PR. stale: herdr says working but the pane stopped
// changing. error: the agent exited or vanished, or the run never started. Those three flag the epic.
// ended: the run is over and its tab closed, or a follow-up never started; the worktree stays until the epic ships
// or its PR is merged or closed, and the PR is scanned for /agent threads meanwhile. kept: cleanup found work that
// is not on origin, so the worktree stays and the epic was told.
const statuses = z.enum(['claimed', 'running', 'awaitingInput', 'stale', 'error', 'ended', 'kept']);

// Names written by older versions.
const renamedStatuses: Record<string, z.infer<typeof statuses>> = { stuck: 'awaitingInput', failed: 'error' };

export const claimStatusSchema = z.preprocess(
	(status) => (typeof status === 'string' && Object.hasOwn(renamedStatuses, status) ? renamedStatuses[status] : status),
	statuses,
);

const claimSchema = z.object({
	epicId: z.string(),
	identifier: z.string(),
	teamId: z.string(),
	status: claimStatusSchema,
	claimedAt: z.number(),
	job: jobSchema.optional(),
	run: runSchema.optional(),
	// since: when the status or, while working, the pane tail last changed.
	agent: z
		.object({
			status: z.union([agentStatusSchema, z.enum(['exited', 'vanished'])]),
			since: z.number(),
			tail: z.string(),
		})
		.optional(),
	// When the current stale episode's nudge was sent; cleared once the pane changes.
	nudgedAt: z.number().optional(),
	// The run passed the wall-clock cap and the epic was told.
	overCap: z.boolean().optional(),
	// The awaitingInput comment whose replies are typed into the pane; cleared when the episode ends.
	questionCommentId: z.string().optional(),
	// The agent's result file and which parts of it are already on the PR, so a restart never posts one twice.
	// replied and resolved hold review thread ids.
	result: z
		.object({
			file: resultFileSchema,
			posted: z.array(z.enum(['summary', 'review'])),
			replied: z.array(z.string()).default([]),
			resolved: z.array(z.string()).default([]),
		})
		.optional(),
});

export type Claim = z.infer<typeof claimSchema>;

const fileSchema = z.object({ claims: z.array(claimSchema) });

export class ClaimStore {
	private readonly path: string;
	private readonly claims: Map<string, Claim>;

	private constructor(path: string, claims: Claim[]) {
		this.path = path;
		this.claims = new Map(claims.map((claim) => [claim.epicId, claim]));
	}

	static async open(path: string) {
		const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return JSON.stringify({ claims: [] });
			}

			throw error;
		});

		return new ClaimStore(path, fileSchema.parse(JSON.parse(text)).claims);
	}

	get(epicId: string) {
		return this.claims.get(epicId);
	}

	all() {
		return [...this.claims.values()];
	}

	async put(claim: Claim) {
		this.claims.set(claim.epicId, claim);
		await this.save();
	}

	async delete(epicId: string) {
		this.claims.delete(epicId);
		await this.save();
	}

	private async save() {
		await writeFileAtomic(this.path, `${JSON.stringify({ claims: this.all() }, null, '\t')}\n`);
	}
}
