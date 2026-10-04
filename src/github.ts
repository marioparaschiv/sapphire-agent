import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ResultFile } from './protocol.ts';

const execFileAsync = promisify(execFile);

const pullRequestSchema = z.object({
	number: z.number().int(),
	url: z.string(),
	state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
	author: z.object({ login: z.string() }),
});

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

const isClaude = (body: string) => body.includes(ON_BEHALF_OF_CLAUDE);

const mentionsAgent = (body: string) => /(^|\s)\/agent\b/.test(body);

// GitHub caps a connection page at 100 nodes.
const MAX_THREADS = 100;

const reviewThreadSchema = z.object({
	id: z.string(),
	isResolved: z.boolean(),
	comments: z.object({
		nodes: z.array(z.object({ body: z.string(), pullRequestReview: z.object({ body: z.string() }).nullable() })),
	}),
});

type ReviewThread = z.infer<typeof reviewThreadSchema>;

// Unresolved, and the user's latest comment asks for the agent, in its body or in the body of the review it was
// submitted with. Comments carrying the onBehalfOf block are the agent's own and never count.
function isPending(thread: ReviewThread) {
	const latest = thread.comments.nodes.findLast((comment) => !isClaude(comment.body));

	return !thread.isResolved && !!latest && (mentionsAgent(latest.body) || mentionsAgent(latest.pullRequestReview?.body ?? ''));
}

// Every GitHub read and write the dispatcher makes, through the `gh` CLI.
export class GitHub {
	private readonly gh: Gh;

	constructor(gh: Gh = runGh) {
		this.gh = gh;
	}

	// The open PR for the branch if there is one, else a merged one, else a closed one.
	async findPullRequest(githubRepo: string, branch: string): Promise<PullRequest | undefined> {
		const stdout = await this.gh(['pr', 'list', '--repo', githubRepo, '--head', branch, '--state', 'all', '--json', 'number,url,state,author']);
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

	// The branch's open PR and its pending review threads (see isPending), or undefined without an open PR.
	async pendingThreads(githubRepo: string, branch: string) {
		const [owner, name] = githubRepo.split('/');
		const data = await this.graphql(
			z.object({
				repository: z.object({
					pullRequests: z.object({
						nodes: z.array(
							z.object({
								url: z.string(),
								reviewThreads: z.object({ totalCount: z.number().int(), nodes: z.array(reviewThreadSchema) }),
							}),
						),
					}),
				}),
			}),
			`query PendingThreads($owner: String!, $name: String!, $branch: String!) {
				repository(owner: $owner, name: $name) {
					pullRequests(headRefName: $branch, states: OPEN, first: 1) {
						nodes {
							url
							reviewThreads(first: ${MAX_THREADS}) {
								totalCount
								nodes { id isResolved comments(last: 100) { nodes { body pullRequestReview { body } } } }
							}
						}
					}
				}
			}`,
			{ owner, name, branch },
		);
		const [pullRequest] = data.repository.pullRequests.nodes;

		if (!pullRequest) {
			return undefined;
		}

		// A truncated page could hide a pending thread.
		if (pullRequest.reviewThreads.totalCount > MAX_THREADS) {
			throw new Error(`${pullRequest.url} has ${pullRequest.reviewThreads.totalCount} review threads, over the ${MAX_THREADS} one query reads`);
		}

		return { url: pullRequest.url, threadIds: pullRequest.reviewThreads.nodes.filter(isPending).map((thread) => thread.id) };
	}

	async replyToThread(threadId: string, body: string) {
		await this.graphql(
			z.object({ addPullRequestReviewThreadReply: z.object({ comment: z.object({ id: z.string() }) }) }),
			`mutation ReplyToThread($threadId: ID!, $body: String!) {
				addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
			}`,
			{ threadId, body: asClaude(body) },
		);
	}

	async resolveThread(threadId: string) {
		await this.graphql(
			z.object({ resolveReviewThread: z.object({ thread: z.object({ isResolved: z.literal(true) }) }) }),
			`mutation ResolveThread($threadId: ID!) {
				resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
			}`,
			{ threadId },
		);
	}

	private async post(endpoint: string, body: Record<string, unknown>) {
		await this.gh(['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body));
	}

	// gh exits non-zero when the response carries GraphQL errors.
	private async graphql<T extends z.ZodType>(schema: T, query: string, variables: Record<string, unknown>): Promise<z.infer<T>> {
		const stdout = await this.gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));

		return schema.parse(z.object({ data: z.unknown() }).parse(JSON.parse(stdout)).data);
	}
}
