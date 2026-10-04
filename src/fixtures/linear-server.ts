import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

// A stand-in for api.linear.app/graphql that understands the operations LinearClient sends, answers with
// Linear-shaped payloads, and applies mutations so later polls see them.

type State = { id: string; name: string; type: string };

export type FakeIssue = {
	id: string;
	identifier: string;
	title: string;
	teamId: string;
	stateId: string;
	parentId: string | null;
	labelIds: string[];
	sortOrder: number;
};

type FakeLabel = { id: string; name: string; teamId: string | null; parentName: string | null };

export type FakeComment = { id: string; issueId: string; body: string; parentId: string | null; createdAt: string; reactions: string[] };

const requestSchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

export const UNBOUND_TEAM_ID = '2f1a5c4e-9b7d-4e0a-8c1f-6d2b3a4e5f60';

export const unboundStates: State[] = [
	{ id: 'st-todo', name: 'To Do', type: 'unstarted' },
	{ id: 'st-ready', name: 'Ready For Agent', type: 'unstarted' },
	{ id: 'st-impl', name: 'Implementing', type: 'started' },
	{ id: 'st-inrev', name: 'In Review', type: 'started' },
	{ id: 'st-torev', name: 'To Review', type: 'started' },
	{ id: 'st-shipped', name: 'Shipped', type: 'completed' },
	{ id: 'st-done', name: 'Done', type: 'completed' },
];

export class FakeLinear {
	readonly teams = [{ id: UNBOUND_TEAM_ID, key: 'UNB', name: 'Unbound', states: unboundStates }];
	readonly issues = new Map<string, FakeIssue>();
	readonly labels: FakeLabel[] = [{ id: 'lbl-loader', name: 'loader-ios', teamId: null, parentName: 'repo' }];
	readonly comments: FakeComment[] = [];
	readonly mutations: string[] = [];
	readonly authorizations = new Set<string>();
	private server: Server | undefined;
	url = '';

	async listen() {
		this.server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];

			for await (const chunk of request) {
				chunks.push(chunk as Buffer);
			}

			this.authorizations.add(request.headers.authorization ?? '');
			const { query, variables } = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			const operation = /^\s*(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '';
			const data = this.resolve(operation, variables);

			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(data === undefined ? { errors: [{ message: `unknown operation ${operation}` }] } : { data }));
		}).listen(0, '127.0.0.1');
		await once(this.server, 'listening');
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/graphql`;
	}

	async close() {
		this.server?.close();
		await once(this.server!, 'close');
	}

	addEpic(issue: Partial<FakeIssue> & Pick<FakeIssue, 'identifier' | 'title'>, subIssues = 2) {
		const epic: FakeIssue = {
			id: `issue-${issue.identifier.toLowerCase()}`,
			teamId: UNBOUND_TEAM_ID,
			stateId: 'st-ready',
			parentId: null,
			labelIds: [],
			sortOrder: this.issues.size,
			...issue,
		};
		this.issues.set(epic.id, epic);

		for (let index = 1; index <= subIssues; index += 1) {
			const number = Number(issue.identifier.split('-')[1]) * 10 + index;
			const child: FakeIssue = {
				...epic,
				id: `${epic.id}-sub-${index}`,
				identifier: `UNB-${number}`,
				title: `Slice ${index}`,
				parentId: epic.id,
				stateId: 'st-todo',
			};
			this.issues.set(child.id, child);
		}

		return epic;
	}

	stateName(issueId: string) {
		const issue = this.issues.get(issueId)!;

		return unboundStates.find((state) => state.id === issue.stateId)?.name;
	}

	// A comment as the user would post it in Linear, e.g. a reply in a question's thread.
	addComment(issueId: string, body: string, parentId: string | null = null) {
		const comment: FakeComment = {
			id: `comment-${this.comments.length + 1}`,
			issueId,
			body,
			parentId,
			createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, this.comments.length)).toISOString(),
			reactions: [],
		};
		this.comments.push(comment);

		return comment;
	}

	labelNames(issueId: string) {
		return this.issues.get(issueId)!.labelIds.map((id) => this.labels.find((label) => label.id === id)?.name);
	}

	private toEpic(issue: FakeIssue) {
		const team = this.teams.find((candidate) => candidate.id === issue.teamId)!;
		const state = team.states.find((candidate) => candidate.id === issue.stateId)!;
		const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			url: `https://linear.app/marioparaschiv/issue/${issue.identifier}/${slug}`,
			branchName: `mario/${issue.identifier.toLowerCase()}-${slug}`,
			sortOrder: issue.sortOrder,
			team: { id: team.id, name: team.name },
			state: { id: state.id, name: state.name },
			labels: {
				nodes: issue.labelIds.map((id) => {
					const label = this.labels.find((candidate) => candidate.id === id)!;

					return { id: label.id, name: label.name, parent: label.parentName ? { name: label.parentName } : null };
				}),
			},
			children: {
				nodes: [...this.issues.values()].filter((child) => child.parentId === issue.id).slice(0, 1).map((child) => ({ id: child.id })),
			},
		};
	}

	private resolve(operation: string, variables: Record<string, unknown>) {
		const strings = (key: string) => z.array(z.string()).parse(variables[key]);
		const string = (key: string) => z.string().parse(variables[key]);

		switch (operation) {
			case 'Teams':
				return {
					teams: {
						nodes: this.teams
							.filter((team) => strings('names').includes(team.name))
							.map((team) => ({ id: team.id, key: team.key, name: team.name, states: { nodes: team.states } })),
					},
				};

			case 'Poll': {
				const issues = [...this.issues.values()];

				return {
					ready: {
						nodes: issues
							.filter((issue) => issue.parentId === null && strings('readyStateIds').includes(issue.stateId))
							.map((issue) => this.toEpic(issue)),
					},
					claimed: { nodes: issues.filter((issue) => strings('claimedIds').includes(issue.id)).map((issue) => this.toEpic(issue)) },
					replies: {
						nodes: this.comments
							.filter((comment) => comment.parentId !== null && strings('questionIds').includes(comment.parentId))
							.map((comment) => ({
								id: comment.id,
								body: comment.body,
								createdAt: comment.createdAt,
								parent: { id: comment.parentId },
								reactions: comment.reactions.map((emoji) => ({ emoji })),
							})),
					},
				};
			}

			case 'Move': {
				this.mutations.push(`move ${string('id')} ${string('stateId')}`);
				this.issues.get(string('id'))!.stateId = string('stateId');

				return { issueUpdate: { success: true } };
			}

			case 'Comment': {
				const parentId = z.string().nullish().parse(variables.parentId) ?? null;
				this.mutations.push(`comment ${string('issueId')}${parentId ? ` in ${parentId}` : ''}`);
				const comment = this.addComment(string('issueId'), string('body'), parentId);

				return { commentCreate: { success: true, comment: { id: comment.id } } };
			}

			case 'React': {
				this.mutations.push(`react ${string('commentId')} ${string('emoji')}`);
				this.comments.find((comment) => comment.id === string('commentId'))!.reactions.push(string('emoji'));

				return { reactionCreate: { success: true } };
			}

			case 'Labels':
				return {
					issueLabels: {
						nodes: this.labels
							.filter((label) => label.name === string('name'))
							.map((label) => ({ id: label.id, team: label.teamId ? { id: label.teamId } : null })),
					},
				};

			case 'CreateLabel': {
				const label = { id: `lbl-${this.labels.length}`, name: string('name'), teamId: string('teamId'), parentName: null };
				this.labels.push(label);
				this.mutations.push(`create-label ${label.name}`);

				return { issueLabelCreate: { success: true, issueLabel: { id: label.id } } };
			}

			case 'AddLabel': {
				this.mutations.push(`add-label ${string('id')} ${string('labelId')}`);
				this.issues.get(string('id'))!.labelIds.push(string('labelId'));

				return { issueAddLabel: { success: true } };
			}

			case 'RemoveLabel': {
				this.mutations.push(`remove-label ${string('id')} ${string('labelId')}`);
				const issue = this.issues.get(string('id'))!;
				issue.labelIds = issue.labelIds.filter((id) => id !== string('labelId'));

				return { issueRemoveLabel: { success: true } };
			}
		}
	}
}
