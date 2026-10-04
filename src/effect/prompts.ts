import { Context, Layer } from 'effect';

export type PromptEpic = {
	readonly identifier: string;
	readonly title: string;
	readonly url: string;
};

export type FollowUpTarget = {
	readonly pullRequestUrl: string;
	readonly threadIds: ReadonlyArray<string>;
};

const tabLabel = ({ identifier, title }: Pick<PromptEpic, 'identifier' | 'title'>) =>
	`${identifier} ${title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title}`;

// The orchestrate and follow-up skills own the workflow (Linear moves, commits, /pr). herdr refuses newlines in a prompt.
const orchestrate = ({ identifier, url }: PromptEpic) =>
	`/orchestrate the sub-issues of Linear epic ${identifier} (${url}) autonomously, in the worktree you are in.`;

const followUp = ({ identifier, url }: PromptEpic, { pullRequestUrl, threadIds }: FollowUpTarget) =>
	`/follow-up Linear epic ${identifier} (${url}), PR ${pullRequestUrl}, threads ${threadIds.join(' ')}, autonomously, in the worktree you are in.`;

export class Prompts extends Context.Service<
	Prompts,
	{
		// Starts with the identifier, which is how herdr-linear recognises the tabs it owns.
		readonly tabLabel: typeof tabLabel;
		readonly orchestrate: typeof orchestrate;
		readonly followUp: typeof followUp;
	}
>()('herdr-linear/Prompts') {
	static readonly layer = Layer.succeed(Prompts, { tabLabel, orchestrate, followUp });
}
