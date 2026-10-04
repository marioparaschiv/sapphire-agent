import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const pullRequestSchema = z.object({ url: z.string(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']) });

export type PullRequest = z.infer<typeof pullRequestSchema>;

// The open PR for the branch if there is one, else a merged one, else a closed one.
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
	const pullRequests = z.array(pullRequestSchema).parse(JSON.parse(stdout));

	return (
		pullRequests.find((pr) => pr.state === 'OPEN') ?? pullRequests.find((pr) => pr.state === 'MERGED') ?? pullRequests[0]
	);
}
