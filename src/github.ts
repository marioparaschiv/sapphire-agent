import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const pullRequestSchema = z.object({ url: z.string(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']) });

export type PullRequest = z.infer<typeof pullRequestSchema> & { state: 'OPEN' | 'MERGED' };

const isLive = (pr: z.infer<typeof pullRequestSchema>): pr is PullRequest => pr.state !== 'CLOSED';

// A closed, unmerged PR doesn't count: the work isn't waiting for review.
export async function findPullRequest(githubRepo: string, branch: string): Promise<PullRequest | undefined> {
	const { stdout } = await execFileAsync('gh', [
		'pr',
		'list',
		'--repo',
		githubRepo,
		'--head',
		branch,
		'--state',
		'all',
		'--json',
		'url,state',
	]);
	const live = z.array(pullRequestSchema).parse(JSON.parse(stdout)).filter(isLive);

	return live.find((pr) => pr.state === 'OPEN') ?? live[0];
}
