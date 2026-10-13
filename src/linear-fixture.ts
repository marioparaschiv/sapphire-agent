import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context, Effect, Layer, Redacted, Schema, Stream, SubscriptionRef } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { hmacHex, postJson, serveFixture } from './fixture-server.ts';
import { type Comment, type Epic, Linear, MAX_PAGE_SIZE, type ReadyEpic, type Team } from './linear.ts';

// A stand-in for api.linear.app/graphql: it understands the operations the Linear service sends, answers with
// Linear-shaped payloads and applies mutations, so later reads see them.

export const signLinearDelivery = hmacHex;

// POSTs the payload as Linear sends a webhook delivery, signed with `secret` unless `signature` overrides the
// Linear-Signature header (null leaves it out), and returns the HTTP status.
export const postLinearDelivery = (url: string, secret: Redacted.Redacted<string>, payload: unknown, signature?: string | null) =>
	Effect.promise(() => {
		const body = JSON.stringify(payload);
		const header = signature === undefined ? signLinearDelivery(secret, body) : signature;

		return postJson(url, body, { 'linear-event': 'Issue', 'linear-delivery': randomUUID(), ...(header === null ? {} : { 'linear-signature': header }) });
	});

// An issue related to another, as Linear lists it among that one's inverse relations: `blocks` for an issue blocking it.
export type FixtureRelation = { readonly type: string; readonly issueId: string };

export type FixtureIssue = {
	readonly id: string;
	readonly identifier: string;
	readonly title: string;
	readonly teamId: string;
	stateId: string;
	readonly parentId: string | null;
	labelIds: ReadonlyArray<string>;
	readonly sortOrder: number;
	readonly createdAt: string;
	readonly inverseRelations: ReadonlyArray<FixtureRelation>;
};

// A label without teamId is a workspace label; parentName is its label group.
export type FixtureLabel = { readonly id: string; readonly name: string; readonly teamId: string | null; readonly parentName: string | null };

export type FixtureComment = { readonly id: string; readonly issueId: string; readonly body: string };

export type EpicSeed = {
	readonly identifier: string;
	readonly title: string;
	// Defaults to the Test team.
	readonly teamId?: string;
	// A state name of the team; defaults to Ready For Agent.
	readonly state?: string;
	readonly labelIds?: ReadonlyArray<string>;
	readonly sortOrder?: number;
	// Defaults to a day before TestClock's epoch, so the epic is past any dispatch settle time.
	readonly createdAt?: string;
	// Sub-issues to create in the team's first state; defaults to 2.
	readonly subIssues?: number;
	readonly inverseRelations?: ReadonlyArray<FixtureRelation>;
};

export type LabelSeed = { readonly name: string; readonly teamId?: string; readonly parentName?: string };

export type LinearFixtureShape = {
	// The GraphQL endpoint on 127.0.0.1.
	readonly url: string;
	readonly addEpic: (seed: EpicSeed) => FixtureIssue;
	readonly addLabel: (seed: LabelSeed) => FixtureLabel;
	// A comment as a user would post it in Linear.
	readonly addComment: (issueId: string, body: string) => FixtureComment;
	readonly issue: (issueId: string) => FixtureIssue;
	readonly moveIssue: (issueId: string, state: string) => void;
	// Sub-issues of the epic, in creation order.
	readonly subIssues: (epicId: string) => ReadonlyArray<FixtureIssue>;
	readonly stateName: (issueId: string) => string;
	readonly labelNames: (issueId: string) => ReadonlyArray<string>;
	// Every comment on the issue, in creation order.
	readonly comments: (issueId: string) => ReadonlyArray<FixtureComment>;
	// Applied writes in order, e.g. `move <issueId> <stateId>`, `comment <issueId>`, `create-label <name>`, `add-label <issueId> <labelId>`, `remove-label <issueId> <labelId>`.
	readonly mutations: ReadonlyArray<string>;
	// Every authorization header received.
	readonly authorizations: ReadonlySet<string>;
	// The nth write request (1-based, counting every mutation request received, failed ones included) is not applied
	// and answers this status with a GraphQL error, plus Retry-After when given.
	readonly failWrite: (n: number, status: number, retryAfterSeconds?: number) => void;
	// The nth write is not applied and is rate limited the way Linear does it: HTTP 400 with a RATELIMITED error code.
	readonly rateLimitWrite: (n: number, retryAfterSeconds?: number) => void;
	// The nth write is applied, then the connection is dropped before any answer, like a crash after the post.
	readonly crashAfterWrite: (n: number) => void;
	// Completes once the fixture's Linear layer has got n answers (a response or a transport error) in total. A retry
	// delay that follows an answer is on the clock by then, so TestClock.adjust can be called safely.
	readonly awaitAnswers: (n: number) => Effect.Effect<void>;
	// Completes once a write armed by crashAfterWrite was applied and the Linear layer saw its connection drop.
	readonly awaitCrash: Effect.Effect<void>;
};

const testTeamId = 'team-test';

export const testTeam: Team = {
	id: testTeamId,
	key: 'TEST',
	name: 'Test',
	states: {
		nodes: [
			{ id: 'state-todo', name: 'To Do', type: 'unstarted' },
			{ id: 'state-ready', name: 'Ready For Agent', type: 'unstarted' },
			{ id: 'state-implementing', name: 'Implementing', type: 'started' },
			{ id: 'state-in-review', name: 'In Review', type: 'started' },
			{ id: 'state-to-review', name: 'To Review', type: 'started' },
			{ id: 'state-shipped', name: 'Shipped', type: 'completed' },
			{ id: 'state-done', name: 'Done', type: 'completed' },
		],
	},
};

// A team sapphire-agent does not watch, whose issues can still block a watched team's epics.
export const otherTeam: Team = {
	id: 'team-ops',
	key: 'OPS',
	name: 'Ops',
	states: {
		nodes: [
			{ id: 'state-ops-todo', name: 'Todo', type: 'unstarted' },
			{ id: 'state-ops-in-progress', name: 'In Progress', type: 'started' },
			{ id: 'state-ops-done', name: 'Done', type: 'completed' },
			{ id: 'state-ops-canceled', name: 'Canceled', type: 'canceled' },
		],
	},
};

const GraphqlRequest = Schema.fromJsonString(Schema.Struct({ query: Schema.String, variables: Schema.Record(Schema.String, Schema.Unknown) }));

const Ids = Schema.Array(Schema.String);

const variableSchemas = {
	Teams: Schema.Struct({ names: Ids }),
	ReadyEpics: Schema.Struct({ stateIds: Ids }),
	Epics: Schema.Struct({ ids: Ids }),
	EpicsByIdentifier: Schema.Struct({
		filter: Schema.Struct({
			or: Schema.Array(
				Schema.Struct({
					and: Schema.Tuple([Schema.Struct({ team: Schema.Struct({ key: Schema.Struct({ eq: Schema.String }) }) }), Schema.Struct({ number: Schema.Struct({ eq: Schema.Number }) })]),
				}),
			),
		}),
	}),
	Comments: Schema.Struct({ issueId: Schema.String, after: Schema.NullOr(Schema.String) }),
	Labels: Schema.Struct({ name: Schema.String }),
	Move: Schema.Struct({ id: Schema.String, stateId: Schema.String }),
	Comment: Schema.Struct({ issueId: Schema.String, body: Schema.String }),
	CreateLabel: Schema.Struct({ name: Schema.String, teamId: Schema.String }),
	AddLabel: Schema.Struct({ id: Schema.String, labelId: Schema.String }),
	RemoveLabel: Schema.Struct({ id: Schema.String, labelId: Schema.String }),
};

type Operation = keyof typeof variableSchemas;

const isOperation = (name: string): name is Operation => Object.hasOwn(variableSchemas, name);

type HttpAnswer = { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };

// `crash`: drop the connection without answering.
type Answer = HttpAnswer | 'crash';

const graphqlError = (status: number, message: string, headers: Record<string, string> = {}, code?: string): HttpAnswer => ({
	status,
	body: { errors: [code === undefined ? { message } : { message, extensions: { code } }] },
	headers,
});

type WriteFailure = { readonly status: number; readonly retryAfterSeconds?: number; readonly code?: string };

const writeFailure = (status: number, retryAfterSeconds?: number, code?: string): WriteFailure => ({
	status,
	...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	...(code === undefined ? {} : { code }),
});

class NotFound extends Error {}

const readBody = async (request: IncomingMessage) => {
	const chunks: Array<Buffer> = [];

	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString('utf8');
};

const make = Effect.gen(function* () {
	const answers = yield* SubscriptionRef.make(0);
	const teams: Array<Team> = [testTeam, otherTeam];
	const issues = new Map<string, FixtureIssue>();
	const labels: Array<FixtureLabel> = [];
	const comments: Array<FixtureComment> = [];
	const mutations: Array<string> = [];
	const authorizations = new Set<string>();
	const writeFailures = new Map<number, WriteFailure>();
	const writeCrashes = new Set<number>();
	let writes = 0;
	let crashes = 0;

	const find = <A>(items: Iterable<A>, predicate: (item: A) => boolean, what: string) => {
		for (const item of items) {
			if (predicate(item)) {
				return item;
			}
		}

		throw new NotFound(`Entity not found: ${what}`);
	};

	const team = (id: string) => find(teams, (candidate) => candidate.id === id, `Team ${id}`);
	const issue = (id: string) => find(issues.values(), (candidate) => candidate.id === id, `Issue ${id}`);
	const label = (id: string) => find(labels, (candidate) => candidate.id === id, `IssueLabel ${id}`);
	const stateOf = (found: FixtureIssue) => find(team(found.teamId).states.nodes, (state) => state.id === found.stateId, `WorkflowState ${found.stateId}`);

	const addComment = (issueId: string, body: string) => {
		const created: FixtureComment = { id: `comment-${comments.length + 1}`, issueId: issue(issueId).id, body };

		comments.push(created);

		return created;
	};

	const toEpic = (found: FixtureIssue): Epic => {
		const owner = team(found.teamId);
		const state = stateOf(found);
		const slug = found.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const child = [...issues.values()].find((candidate) => candidate.parentId === found.id);

		return {
			id: found.id,
			identifier: found.identifier,
			title: found.title,
			url: `https://linear.app/marioparaschiv/issue/${found.identifier}/${slug}`,
			branchName: `mario/${found.identifier.toLowerCase()}-${slug}`,
			sortOrder: found.sortOrder,
			createdAt: found.createdAt,
			team: { id: owner.id, name: owner.name },
			state: { id: state.id, name: state.name },
			labels: {
				nodes: found.labelIds.map(label).map(({ id, name, parentName }) => ({ id, name, parent: parentName === null ? null : { name: parentName } })),
			},
			parent: found.parentId === null ? null : { identifier: issue(found.parentId).identifier },
			children: { nodes: child ? [{ id: child.id }] : [] },
		};
	};

	const toReadyEpic = (found: FixtureIssue): ReadyEpic => ({
		...toEpic(found),
		inverseRelations: {
			nodes: found.inverseRelations.map(({ type, issueId }) => {
				const related = issue(issueId);

				return { type, issue: { identifier: related.identifier, state: { type: stateOf(related).type } } };
			}),
		},
	});

	const toComment = (found: FixtureComment): Comment => ({ body: found.body });

	const resolve = (operation: Operation, variables: unknown): unknown => {
		const issueList = [...issues.values()];

		switch (operation) {
			case 'Teams': {
				const { names } = Schema.decodeUnknownSync(variableSchemas.Teams)(variables);

				return { teams: { nodes: teams.filter((candidate) => names.includes(candidate.name)) } };
			}

			case 'ReadyEpics': {
				const { stateIds } = Schema.decodeUnknownSync(variableSchemas.ReadyEpics)(variables);
				const ready = issueList.filter((candidate) => candidate.parentId === null && stateIds.includes(candidate.stateId));

				return { issues: { nodes: ready.slice(0, 50).map(toReadyEpic) } };
			}

			case 'Epics': {
				const { ids } = Schema.decodeUnknownSync(variableSchemas.Epics)(variables);

				return { issues: { nodes: issueList.filter((candidate) => ids.includes(candidate.id)).slice(0, MAX_PAGE_SIZE).map(toEpic) } };
			}

			case 'EpicsByIdentifier': {
				const { filter } = Schema.decodeUnknownSync(variableSchemas.EpicsByIdentifier)(variables);
				const matches = (candidate: FixtureIssue) =>
					filter.or.some(({ and: [{ team: { key } }, { number }] }) => team(candidate.teamId).key === key.eq && candidate.identifier === `${key.eq}-${number.eq}`);

				return { issues: { nodes: issueList.filter(matches).slice(0, MAX_PAGE_SIZE).map(toEpic) } };
			}

			case 'Comments': {
				const { issueId, after } = Schema.decodeUnknownSync(variableSchemas.Comments)(variables);
				const onIssue = comments.filter((candidate) => candidate.issueId === issueId);
				const start = after === null ? 0 : onIssue.findIndex((candidate) => candidate.id === after) + 1;
				const page = onIssue.slice(start, start + MAX_PAGE_SIZE);
				const hasNextPage = start + MAX_PAGE_SIZE < onIssue.length;

				return { comments: { nodes: page.map(toComment), pageInfo: { hasNextPage, endCursor: page.at(-1)?.id ?? null } } };
			}

			case 'Labels': {
				const { name } = Schema.decodeUnknownSync(variableSchemas.Labels)(variables);
				const named = labels.filter((candidate) => candidate.name === name);

				return { issueLabels: { nodes: named.map((found) => ({ id: found.id, team: found.teamId === null ? null : { id: found.teamId } })) } };
			}

			case 'Move': {
				const { id, stateId } = Schema.decodeUnknownSync(variableSchemas.Move)(variables);
				const found = issue(id);

				find(team(found.teamId).states.nodes, (state) => state.id === stateId, `WorkflowState ${stateId}`);
				found.stateId = stateId;
				mutations.push(`move ${id} ${stateId}`);

				return { issueUpdate: { success: true } };
			}

			case 'Comment': {
				const { issueId, body } = Schema.decodeUnknownSync(variableSchemas.Comment)(variables);

				addComment(issueId, body);
				mutations.push(`comment ${issueId}`);

				return { commentCreate: { success: true } };
			}

			case 'CreateLabel': {
				const { name, teamId } = Schema.decodeUnknownSync(variableSchemas.CreateLabel)(variables);
				const created: FixtureLabel = { id: `label-${labels.length + 1}`, name, teamId: team(teamId).id, parentName: null };

				labels.push(created);
				mutations.push(`create-label ${name}`);

				return { issueLabelCreate: { success: true, issueLabel: { id: created.id } } };
			}

			case 'AddLabel': {
				const { id, labelId } = Schema.decodeUnknownSync(variableSchemas.AddLabel)(variables);
				const found = issue(id);

				label(labelId);
				found.labelIds = found.labelIds.includes(labelId) ? found.labelIds : [...found.labelIds, labelId];
				mutations.push(`add-label ${id} ${labelId}`);

				return { issueAddLabel: { success: true } };
			}

			case 'RemoveLabel': {
				const { id, labelId } = Schema.decodeUnknownSync(variableSchemas.RemoveLabel)(variables);
				const found = issue(id);

				found.labelIds = found.labelIds.filter((candidate) => candidate !== labelId);
				mutations.push(`remove-label ${id} ${labelId}`);

				return { issueRemoveLabel: { success: true } };
			}
		}
	};

	const answer = (text: string): Answer => {
		const request = Schema.decodeUnknownSync(GraphqlRequest)(text);
		const [, kind = '', operation = ''] = /^\s*(query|mutation) (\w+)/.exec(request.query) ?? [];

		if (!isOperation(operation)) {
			return graphqlError(400, `unknown operation ${operation}`);
		}

		if (kind !== 'mutation') {
			return { status: 200, body: { data: resolve(operation, request.variables) } };
		}

		writes += 1;
		const failure = writeFailures.get(writes);

		if (failure) {
			const headers: Record<string, string> = failure.retryAfterSeconds === undefined ? {} : { 'retry-after': String(failure.retryAfterSeconds) };

			return graphqlError(failure.status, `injected failure of write ${writes}`, headers, failure.code);
		}

		const data = resolve(operation, request.variables);

		return writeCrashes.has(writes) ? 'crash' : { status: 200, body: { data } };
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		authorizations.add(request.headers.authorization ?? '');

		let result: Answer;

		try {
			result = answer(await readBody(request));
		} catch (error) {
			if (!(error instanceof NotFound) && !Schema.isSchemaError(error)) {
				throw error;
			}

			result = graphqlError(error instanceof NotFound ? 200 : 400, error.message);
		}

		if (result === 'crash') {
			crashes += 1;
			request.socket.destroy();

			return;
		}

		response.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
		response.end(JSON.stringify(result.body));
	};

	const url = yield* serveFixture((request, response) => {
		handle(request, response).catch((error: unknown) => {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ errors: [{ message: `fixture bug: ${String(error)}` }] }));
		});
	});

	const fixture: LinearFixtureShape = {
		url: `${url}/graphql`,
		addEpic: ({ identifier, title, teamId = testTeamId, state = 'Ready For Agent', labelIds = [], sortOrder = issues.size, createdAt = new Date(-86_400_000).toISOString(), subIssues = 2, inverseRelations = [] }) => {
			const owner = team(teamId);
			const epic: FixtureIssue = {
				id: `issue-${identifier.toLowerCase()}`,
				identifier,
				title,
				teamId,
				stateId: find(owner.states.nodes, (candidate) => candidate.name === state, `WorkflowState ${state}`).id,
				parentId: null,
				labelIds,
				sortOrder,
				createdAt,
				inverseRelations,
			};

			issues.set(epic.id, epic);

			for (let index = 1; index <= subIssues; index += 1) {
				const child: FixtureIssue = {
					id: `${epic.id}-sub-${index}`,
					identifier: `${owner.key}-${Number(identifier.split('-')[1]) * 10 + index}`,
					title: `Slice ${index}`,
					teamId,
					stateId: owner.states.nodes[0].id,
					parentId: epic.id,
					labelIds: [],
					sortOrder: index,
					createdAt,
					inverseRelations: [],
				};

				issues.set(child.id, child);
			}

			return epic;
		},
		addLabel: ({ name, teamId, parentName }) => {
			const added: FixtureLabel = { id: `label-${labels.length + 1}`, name, teamId: teamId ?? null, parentName: parentName ?? null };

			labels.push(added);

			return added;
		},
		addComment,
		issue,
		moveIssue: (issueId, state) => {
			const found = issue(issueId);

			found.stateId = find(team(found.teamId).states.nodes, (candidate) => candidate.name === state, `WorkflowState ${state}`).id;
		},
		subIssues: (epicId) => [...issues.values()].filter((candidate) => candidate.parentId === epicId),
		stateName: (issueId) => stateOf(issue(issueId)).name,
		labelNames: (issueId) => issue(issueId).labelIds.map((id) => label(id).name),
		comments: (issueId) => comments.filter((candidate) => candidate.issueId === issueId),
		mutations,
		authorizations,
		failWrite: (n, status, retryAfterSeconds) => {
			writeFailures.set(n, writeFailure(status, retryAfterSeconds));
		},
		rateLimitWrite: (n, retryAfterSeconds) => {
			writeFailures.set(n, writeFailure(400, retryAfterSeconds, 'RATELIMITED'));
		},
		crashAfterWrite: (n) => {
			writeCrashes.add(n);
		},
		awaitAnswers: (n) =>
			SubscriptionRef.changes(answers).pipe(
				Stream.takeUntil((count) => count >= n),
				Stream.runDrain,
			),
		awaitCrash: SubscriptionRef.changes(answers).pipe(
			Stream.takeUntil(() => crashes > 0),
			Stream.runDrain,
		),
	};

	const client = (yield* HttpClient.HttpClient).pipe(HttpClient.transformResponse(Effect.onExit(() => SubscriptionRef.update(answers, (count) => count + 1))));

	return { fixture, client };
}).pipe(Effect.provide(FetchHttpClient.layer));

export class LinearFixture extends Context.Service<LinearFixture, LinearFixtureShape>()('sapphire-agent/LinearFixture') {
	// A fresh fixture server for the layer's lifetime, and a Linear service talking to it over a real HttpClient.
	static readonly layer = Layer.unwrap(
		Effect.map(make, ({ fixture, client }) =>
			Linear.layer(fixture.url).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)), Layer.merge(Layer.succeed(LinearFixture, fixture))),
		),
	);
}
