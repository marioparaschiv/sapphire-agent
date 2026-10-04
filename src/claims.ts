import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.ts';
import { agentStatusSchema, jobSchema, runSchema } from './protocol.ts';

// claimed: recorded before the dispatch is sent. running: the worker confirmed the agent started.
// stuck: the agent stopped without a PR and the epic was flagged. failed: the run never started.
export const claimStatusSchema = z.enum(['claimed', 'running', 'stuck', 'failed']);

const claimSchema = z.object({
	epicId: z.string(),
	identifier: z.string(),
	teamId: z.string(),
	status: claimStatusSchema,
	claimedAt: z.number(),
	job: jobSchema.optional(),
	run: runSchema.optional(),
	agent: z
		.object({
			status: z.union([agentStatusSchema, z.enum(['exited', 'vanished'])]),
			since: z.number(),
			tail: z.string(),
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
