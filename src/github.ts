import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ResultFile } from './protocol.ts';

const execFileAsync = promisify(execFile);

const pullRequestSchema = z.object({ number: z.number().int(), url: z.string(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']) });

export type PullRequest = z.infer<typeof pullRequestSchema>;

// Runs `gh` with the arguments and, when given, `input` on stdin; resolves with stdout.
export type Gh = (args: string[], input?: string) => Promise<string>;

export const runGh: Gh = async (args, input) => {
	const pending = execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 });
	pending.child.stdin?.end(input ?? '');

	return (await pending).stdout;
};

// Linear shows a GitHub comment carrying this block as written by Claude. The agent and the user share one GitHub
// account, so it is the only way to tell the agent's comments from the user's.
export const ON_BEHALF_OF_CLAUDE =
	'<!-- linear:extension {"version":1,"plugins":[{"plugin":"onBehalfOf","agent":"claude"}]} -->';

const asClaude = (body: string) => `${body}\n\n${ON_BEHALF_OF_CLAUDE}`;

// Every GitHub read and write the dispatcher makes, through the `gh` CLI.
export class GitHub {
	private readonly gh: Gh;

	constructor(gh: Gh = runGh) {
		this.gh = gh;
	}

	// The open PR for the branch if there is one, else a merged one, else a closed one.
	async findPullRequest(githubRepo: string, branch: string): Promise<PullRequest | undefined> {
		const stdout = await this.gh(['pr', 'list', '--repo', githubRepo, '--head', branch, '--state', 'all', '--json', 'number,url,state']);
		const pullRequests = z.array(pullRequestSchema).parse(JSON.parse(stdout));

		return (
			pullRequests.find((pr) => pr.state === 'OPEN') ?? pullRequests.find((pr) => pr.state === 'MERGED') ?? pullRequests[0]
		);
	}

	async comment(githubRepo: string, number: number, body: string) {
		await this.post(`repos/${githubRepo}/issues/${number}/comments`, { body: asClaude(body) });
	}

	// One review holding every flag as an inline comment on the PR's new code.
	async review(githubRepo: string, number: number, flags: ResultFile['flags']) {
		await this.post(`repos/${githubRepo}/pulls/${number}/reviews`, {
			event: 'COMMENT',
			body: asClaude('Self-review findings I did not fix in this PR.'),
			comments: flags.map(({ path, line, body }) => ({ path, line, side: 'RIGHT', body: asClaude(body) })),
		});
	}

	private async post(endpoint: string, body: Record<string, unknown>) {
		await this.gh(['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body));
	}
}
