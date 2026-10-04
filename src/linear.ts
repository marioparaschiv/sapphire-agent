import { z } from 'zod';

const stateSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });

const teamSchema = z.object({
	id: z.string(),
	key: z.string(),
	name: z.string(),
	states: z.object({ nodes: z.array(stateSchema) }),
});

export type LinearTeam = z.infer<typeof teamSchema>;

const epicSchema = z.object({
	id: z.string(),
	identifier: z.string(),
	title: z.string(),
	url: z.string(),
	branchName: z.string(),
	sortOrder: z.number(),
	team: z.object({ id: z.string(), name: z.string() }),
	state: z.object({ id: z.string(), name: z.string() }),
	labels: z.object({
		nodes: z.array(z.object({ id: z.string(), name: z.string(), parent: z.object({ name: z.string() }).nullable() })),
	}),
	children: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
});

export type Epic = z.infer<typeof epicSchema>;

const EPIC_FIELDS = `
	id identifier title url branchName sortOrder
	team { id name }
	state { id name }
	labels { nodes { id name parent { name } } }
	children(first: 1) { nodes { id } }
`;

const responseSchema = z.object({
	data: z.unknown().nullable().optional(),
	errors: z.array(z.object({ message: z.string() })).optional(),
});

const successSchema = z.object({ success: z.literal(true) });

export class LinearError extends Error {}

export class LinearClient {
	private readonly endpoint: string;
	private readonly apiKey: string;
	private readonly labelIds = new Map<string, string>();

	constructor(options: { apiKey: string; endpoint?: string }) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? 'https://api.linear.app/graphql';
	}

	private async request<T extends z.ZodType>(schema: T, query: string, variables: Record<string, unknown>): Promise<z.infer<T>> {
		const response = await fetch(this.endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: this.apiKey },
			body: JSON.stringify({ query, variables }),
		});
		const body = responseSchema.safeParse(await response.json().catch(() => null));

		if (!body.success) {
			throw new LinearError(`Linear answered HTTP ${response.status} with an unreadable body`);
		}

		if (body.data.errors?.length || !response.ok) {
			const messages = body.data.errors?.map((error) => error.message).join('; ');

			throw new LinearError(`Linear answered HTTP ${response.status}: ${messages ?? 'no error message'}`);
		}

		return schema.parse(body.data.data);
	}

	async teams(names: string[]) {
		const result = await this.request(
			z.object({ teams: z.object({ nodes: z.array(teamSchema) }) }),
			`query Teams($names: [String!]) {
				teams(filter: { name: { in: $names } }) { nodes { id key name states { nodes { id name type } } } }
			}`,
			{ names },
		);

		return result.teams.nodes;
	}

	// Top-level issues in the ready states, plus the claimed issues wherever they are now.
	async poll(readyStateIds: string[], claimedIds: string[]) {
		const result = await this.request(
			z.object({
				ready: z.object({ nodes: z.array(epicSchema) }),
				claimed: z.object({ nodes: z.array(epicSchema) }),
			}),
			`query Poll($readyStateIds: [ID!], $claimedIds: [ID!]) {
				ready: issues(first: 50, filter: { state: { id: { in: $readyStateIds } }, parent: { null: true } }) {
					nodes { ${EPIC_FIELDS} }
				}
				claimed: issues(first: 50, filter: { id: { in: $claimedIds } }) { nodes { ${EPIC_FIELDS} } }
			}`,
			{ readyStateIds, claimedIds },
		);

		return { ready: result.ready.nodes, claimed: result.claimed.nodes };
	}

	async moveIssue(issueId: string, stateId: string) {
		await this.request(
			z.object({ issueUpdate: successSchema }),
			`mutation Move($id: String!, $stateId: String!) {
				issueUpdate(id: $id, input: { stateId: $stateId }) { success }
			}`,
			{ id: issueId, stateId },
		);
	}

	async comment(issueId: string, body: string) {
		await this.request(
			z.object({ commentCreate: successSchema }),
			`mutation Comment($issueId: String!, $body: String!) {
				commentCreate(input: { issueId: $issueId, body: $body }) { success }
			}`,
			{ issueId, body },
		);
	}

	async addLabel(issueId: string, teamId: string, name: string) {
		const labelId = await this.labelId(teamId, name);

		await this.request(
			z.object({ issueAddLabel: successSchema }),
			`mutation AddLabel($id: String!, $labelId: String!) {
				issueAddLabel(id: $id, labelId: $labelId) { success }
			}`,
			{ id: issueId, labelId },
		);
	}

	async removeLabel(issueId: string, labelId: string) {
		await this.request(
			z.object({ issueRemoveLabel: successSchema }),
			`mutation RemoveLabel($id: String!, $labelId: String!) {
				issueRemoveLabel(id: $id, labelId: $labelId) { success }
			}`,
			{ id: issueId, labelId },
		);
	}

	// A workspace label wins over a team label of the same name; the team label is created if neither exists.
	private async labelId(teamId: string, name: string) {
		const cacheKey = `${teamId}/${name}`;
		const cached = this.labelIds.get(cacheKey);

		if (cached) {
			return cached;
		}

		const { issueLabels } = await this.request(
			z.object({
				issueLabels: z.object({
					nodes: z.array(z.object({ id: z.string(), team: z.object({ id: z.string() }).nullable() })),
				}),
			}),
			`query Labels($name: String!) {
				issueLabels(filter: { name: { eq: $name } }) { nodes { id team { id } } }
			}`,
			{ name },
		);
		const existing =
			issueLabels.nodes.find((label) => label.team === null) ?? issueLabels.nodes.find((label) => label.team?.id === teamId);
		const labelId =
			existing?.id ??
			(
				await this.request(
					z.object({ issueLabelCreate: z.object({ success: z.literal(true), issueLabel: z.object({ id: z.string() }) }) }),
					`mutation CreateLabel($name: String!, $teamId: String!) {
						issueLabelCreate(input: { name: $name, teamId: $teamId }) { success issueLabel { id } }
					}`,
					{ name, teamId },
				)
			).issueLabelCreate.issueLabel.id;

		this.labelIds.set(cacheKey, labelId);

		return labelId;
	}
}
