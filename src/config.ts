import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

const pathSchema = z.string().min(1).transform(expandHome);

const teamSchema = z.strictObject({
	repo: pathSchema,
	// An epic labelled `<repoPrefix><name>` runs in `<labelReposDirectory>/<name>` instead of `repo`.
	labelReposDirectory: pathSchema.optional(),
});

export type TeamConfig = z.infer<typeof teamSchema>;

// Renames the key older versions used.
const renameStuckAfterSeconds = (config: unknown) => {
	if (typeof config !== 'object' || config === null || !('stuckAfterSeconds' in config)) {
		return config;
	}

	const { stuckAfterSeconds, ...rest } = config;

	return { awaitingInputAfterSeconds: stuckAfterSeconds, ...rest };
};

export const configSchema = z.preprocess(
	renameStuckAfterSeconds,
	z.strictObject({
		pollSeconds: z.number().int().min(5).default(30),
		maxInFlight: z.number().int().min(1).default(1),
		// How long an agent may sit idle or blocked without a PR before the epic is flagged as awaiting input.
		awaitingInputAfterSeconds: z.number().int().min(30).default(180),
		// How long a dispatched run may take to confirm Claude started before it is flagged as an error. Starts run
		// one at a time, so this covers waiting behind other starts as well as the fetch and herdr's 30 s start wait.
		startTimeoutSeconds: z.number().int().min(60).default(300),
		// How long herdr may report working while the pane tail stays the same before the agent is nudged.
		staleAfterSeconds: z.number().int().min(60).default(600),
		// How long after the nudge the tail may stay the same before the epic is flagged as stale.
		nudgeGraceSeconds: z.number().int().min(60).default(600),
		// How long a run may go, in any state, before the epic is flagged once.
		maxRunSeconds: z.number().int().min(600).default(5400),
		worktreesDirectory: pathSchema.default(join(homedir(), '.herdr/worktrees')),
		workspaceLabel: z.string().min(1).default('agents'),
		states: z
			.strictObject({
				ready: z.string().min(1).default('Ready For Agent'),
				implementing: z.string().min(1).default('Implementing'),
				inReview: z.string().min(1).default('In Review'),
				toReview: z.string().min(1).default('To Review'),
				shipped: z.string().min(1).default('Shipped'),
			})
			.prefault({}),
		labels: z
			.strictObject({
				stuck: z.string().min(1).default('agent-stuck'),
				repoPrefix: z.string().min(1).default('repo:'),
			})
			.prefault({}),
		teams: z.record(z.string().min(1), teamSchema).refine((teams) => Object.keys(teams).length > 0, 'no teams configured'),
	}),
);

export type Config = z.infer<typeof configSchema>;

export type StateRole = keyof Config['states'];

export async function loadConfig(path: string): Promise<Config> {
	const text = await readFile(path, 'utf8');
	const result = configSchema.safeParse(JSON.parse(text));

	if (!result.success) {
		throw new Error(`invalid config ${path}:\n${z.prettifyError(result.error)}`);
	}

	return result.data;
}

export type IssueLabel = { name: string; parent: { name: string } | null };

export type RepoResolution = { ok: true; path: string } | { ok: false; error: string };

const repoNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveRepo(config: Config, teamName: string, labels: IssueLabel[]): RepoResolution {
	const team = config.teams[teamName];

	if (!team) {
		return { ok: false, error: `team ${teamName} has no repo in the config` };
	}

	const prefix = config.labels.repoPrefix;
	// Linear shows a label inside a group named `repo` as `repo/<name>`, so accept both spellings.
	const group = prefix.replace(/:$/, '');
	const repoNames = labels.flatMap((label) => {
		if (label.name.startsWith(prefix)) {
			return [label.name.slice(prefix.length)];
		}

		return label.parent?.name === group ? [label.name] : [];
	});

	if (repoNames.length === 0) {
		return { ok: true, path: team.repo };
	}

	if (repoNames.length > 1) {
		return { ok: false, error: `the epic has more than one repo label: ${repoNames.join(', ')}` };
	}

	const [name] = repoNames;

	if (!team.labelReposDirectory) {
		return { ok: false, error: `the epic is labelled ${prefix}${name}, but team ${teamName} has no labelReposDirectory` };
	}

	if (!repoNamePattern.test(name)) {
		return { ok: false, error: `${JSON.stringify(name)} is not a valid repo name` };
	}

	return { ok: true, path: join(team.labelReposDirectory, name) };
}
