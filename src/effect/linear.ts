import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Headers, HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from 'effect/http';
import { callTimeouts, Permanent, Transient, withCallPolicy, type CallError } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { hasMarker, type MarkedComment } from './markers.ts';

const nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) });

export const State = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String });

export type State = typeof State.Type;

export const Team = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String, states: nodes(State) });

export type Team = typeof Team.Type;

export const Label = Schema.Struct({ id: Schema.String, name: Schema.String, parent: Schema.NullOr(Schema.Struct({ name: Schema.String })) });

export type Label = typeof Label.Type;

export const Epic = Schema.Struct({
	id: Schema.String,
	identifier: Schema.String,
	title: Schema.String,
	url: Schema.String,
	branchName: Schema.String,
	sortOrder: Schema.Number,
	team: Schema.Struct({ id: Schema.String, name: Schema.String }),
	state: Schema.Struct({ id: Schema.String, name: Schema.String }),
	labels: nodes(Label),
	// At most one sub-issue, only to know whether the epic has any.
	children: nodes(Schema.Struct({ id: Schema.String })),
});

export type Epic = typeof Epic.Type;

const Reaction = Schema.Struct({ emoji: Schema.String });

export const Comment = Schema.Struct({
	id: Schema.String,
	body: Schema.String,
	createdAt: Schema.String,
	parent: Schema.NullOr(Schema.Struct({ id: Schema.String })),
	reactions: Schema.Array(Reaction),
});

export type Comment = typeof Comment.Type;

// A comment in a question's thread.
export const Reply = Schema.Struct({ ...Comment.fields, parent: Schema.Struct({ id: Schema.String }) });

export type Reply = typeof Reply.Type;

const EPIC_FIELDS = `
	id identifier title url branchName sortOrder
	team { id name }
	state { id name }
	labels { nodes { id name parent { name } } }
	children(first: 1) { nodes { id } }
`;

const COMMENT_FIELDS = 'id body createdAt parent { id } reactions { emoji }';

// Linear rejects larger pages.
export const MAX_PAGE_SIZE = 250;

const Success = Schema.Struct({ success: Schema.Literal(true) });

const GraphqlResponse = Schema.fromJsonString(
	Schema.Struct({
		data: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
		errors: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					message: Schema.String,
					extensions: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
				}),
			),
		),
	}),
);

const PageInfo = Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) });

const CommentsPage = Schema.Struct({ comments: Schema.Struct({ nodes: Schema.Array(Comment), pageInfo: PageInfo }) });

const IssueLabels = Schema.Struct({ issueLabels: nodes(Schema.Struct({ id: Schema.String, team: Schema.NullOr(Schema.Struct({ id: Schema.String })) })) });

const retryAfter = (response: HttpClientResponse.HttpClientResponse) =>
	Headers.get(response.headers, 'retry-after').pipe(
		Option.map(Number),
		Option.filter((seconds) => Number.isFinite(seconds) && seconds >= 0),
		Option.map(Duration.seconds),
	);

const rateLimited = (response: HttpClientResponse.HttpClientResponse) => {
	const wait = retryAfter(response);

	return new Transient({ message: `Linear answered HTTP ${response.status}: rate limited`, ...(Option.isSome(wait) ? { retryAfter: wait.value } : {}) });
};

const transportFailure = (error: HttpClientError.HttpClientError) =>
	error.reason._tag === 'TransportError'
		? new Transient({ message: `Linear could not be reached: ${error.message}`, cause: error })
		: new Permanent({ message: `Linear request failed: ${error.message}`, cause: error });

export type LinearShape = {
	// Teams by exact name, with all their workflow states.
	readonly teams: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Team>, CallError>;
	// Top-level issues in the given states, at most 50.
	readonly readyEpics: (stateIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Epic>, CallError>;
	// The given issues wherever they are now; fails Permanent for more than 250 ids.
	readonly epics: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Epic>, CallError>;
	// The issues with the given identifiers (e.g. HL-8) wherever they are now; fails Permanent for more than 250.
	readonly epicsByIdentifier: (identifiers: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Epic>, CallError>;
	// The replies in the threads of the given comments, at most 250.
	readonly replies: (questionIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Reply>, CallError>;
	// Every comment on the issue, replies included, oldest first.
	readonly comments: (issueId: string) => Effect.Effect<ReadonlyArray<Comment>, CallError>;
	readonly moveIssue: (issueId: string, stateId: string) => Effect.Effect<void, CallError>;
	// Returns the ID of the issue's comment carrying the marker, posting it first (as a reply when parentId is
	// given) only if no comment carries it yet.
	readonly comment: (issueId: string, comment: MarkedComment, parentId?: string) => Effect.Effect<string, CallError>;
	// Adds the reaction unless the comment already has that emoji.
	readonly react: (commentId: string, emoji: string) => Effect.Effect<void, CallError>;
	// A workspace label wins over a team label of the same name; the team label is created if neither exists.
	readonly addLabel: (issueId: string, teamId: string, name: string) => Effect.Effect<void, CallError>;
	readonly removeLabel: (issueId: string, labelId: string) => Effect.Effect<void, CallError>;
};

const make = (endpoint: string) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const { linearApiKey } = yield* AppConfig;
		const labelIds = new Map<string, string>();

		const request = <A>(data: Schema.ConstraintDecoder<A>, query: string, variables: Record<string, unknown>) =>
			Effect.gen(function* () {
				const response = yield* HttpClientRequest.post(endpoint).pipe(
					HttpClientRequest.setHeader('authorization', Redacted.value(linearApiKey)),
					HttpClientRequest.bodyJsonUnsafe({ query, variables }),
					client.execute,
					Effect.mapError(transportFailure),
				);
				const { status } = response;

				if (status === 429) {
					return yield* rateLimited(response);
				}

				if (status >= 500) {
					return yield* new Transient({ message: `Linear answered HTTP ${status}` });
				}

				const text = yield* response.text.pipe(Effect.mapError(transportFailure));
				const body = yield* Schema.decodeEffect(GraphqlResponse)(text).pipe(
					Effect.mapError((cause) => new Permanent({ message: `Linear answered HTTP ${status} with an unreadable body`, cause })),
				);

				// Linear reports most rate limits as HTTP 400 with this GraphQL error code rather than a 429.
				if (body.errors?.some((error) => error.extensions?.code === 'RATELIMITED')) {
					return yield* rateLimited(response);
				}

				if (body.errors?.length || status < 200 || status >= 300) {
					const messages = body.errors?.map((error) => error.message).join('; ');

					return yield* new Permanent({ message: `Linear answered HTTP ${status}: ${messages || 'no error message'}` });
				}

				return yield* Schema.decodeUnknownEffect(data)(body.data).pipe(
					Effect.mapError((cause) => new Permanent({ message: `Linear answered with unexpected data: ${cause.message}`, cause })),
				);
			});

		const readComments = Effect.fn(function* (issueId: string) {
			const comments: Array<Comment> = [];
			let after: string | null = null;

			do {
				const { comments: page }: typeof CommentsPage.Type = yield* request(
					CommentsPage,
					`query Comments($issueId: ID!, $after: String) {
						comments(first: ${MAX_PAGE_SIZE}, after: $after, filter: { issue: { id: { eq: $issueId } } }) {
							nodes { ${COMMENT_FIELDS} }
							pageInfo { hasNextPage endCursor }
						}
					}`,
					{ issueId, after },
				);

				comments.push(...page.nodes);
				after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
			} while (after !== null);

			return comments;
		});

		const labelId = Effect.fn(function* (teamId: string, name: string) {
			const cacheKey = `${teamId}/${name}`;
			const cached = labelIds.get(cacheKey);

			if (cached) {
				return cached;
			}

			const { issueLabels } = yield* request(
				IssueLabels,
				`query Labels($name: String!) {
					issueLabels(filter: { name: { eq: $name } }) { nodes { id team { id } } }
				}`,
				{ name },
			);
			const existing = issueLabels.nodes.find((label) => label.team === null) ?? issueLabels.nodes.find((label) => label.team?.id === teamId);
			const id =
				existing?.id ??
				(yield* request(
					Schema.Struct({ issueLabelCreate: Schema.Struct({ ...Success.fields, issueLabel: Schema.Struct({ id: Schema.String }) }) }),
					`mutation CreateLabel($name: String!, $teamId: String!) {
						issueLabelCreate(input: { name: $name, teamId: $teamId }) { success issueLabel { id } }
					}`,
					{ name, teamId },
				)).issueLabelCreate.issueLabel.id;

			labelIds.set(cacheKey, id);

			return id;
		});

		const withPolicy = withCallPolicy(callTimeouts.linear);

		// Each method is one unit under the call policy, so a retry repeats the marker or reaction check before
		// writing again.
		return Linear.of({
			teams: (names) =>
				request(
					Schema.Struct({ teams: nodes(Team) }),
					`query Teams($names: [String!]) {
						teams(filter: { name: { in: $names } }) { nodes { id key name states { nodes { id name type } } } }
					}`,
					{ names },
				).pipe(
					Effect.map((result) => result.teams.nodes),
					withPolicy,
				),

			readyEpics: (stateIds) =>
				stateIds.length === 0
					? Effect.succeed([])
					: request(
							Schema.Struct({ issues: nodes(Epic) }),
							`query ReadyEpics($stateIds: [ID!]) {
								issues(first: 50, filter: { state: { id: { in: $stateIds } }, parent: { null: true } }) { nodes { ${EPIC_FIELDS} } }
							}`,
							{ stateIds },
						).pipe(
							Effect.map((result) => result.issues.nodes),
							withPolicy,
						),

			epics: (ids) => {
				if (ids.length === 0) {
					return Effect.succeed([]);
				}

				// A truncated page would make epics that still exist look gone.
				if (ids.length > MAX_PAGE_SIZE) {
					return Effect.fail(new Permanent({ message: `${ids.length} epics exceed the ${MAX_PAGE_SIZE} issues one read can return` }));
				}

				return request(
					Schema.Struct({ issues: nodes(Epic) }),
					`query Epics($ids: [ID!]) {
						issues(first: ${MAX_PAGE_SIZE}, filter: { id: { in: $ids } }) { nodes { ${EPIC_FIELDS} } }
					}`,
					{ ids },
				).pipe(
					Effect.map((result) => result.issues.nodes),
					withPolicy,
				);
			},

			epicsByIdentifier: (identifiers) => {
				if (identifiers.length === 0) {
					return Effect.succeed([]);
				}

				if (identifiers.length > MAX_PAGE_SIZE) {
					return Effect.fail(new Permanent({ message: `${identifiers.length} identifiers exceed the ${MAX_PAGE_SIZE} issues one read can return` }));
				}

				// The id filter takes only UUIDs, so an identifier is matched by its team key and number.
				const filter = {
					or: identifiers.map((identifier) => {
						const [key, number] = identifier.split('-');

						return { team: { key: { eq: key } }, number: { eq: Number(number) } };
					}),
				};

				return request(
					Schema.Struct({ issues: nodes(Epic) }),
					`query EpicsByIdentifier($filter: IssueFilter) {
						issues(first: ${MAX_PAGE_SIZE}, filter: $filter) { nodes { ${EPIC_FIELDS} } }
					}`,
					{ filter },
				).pipe(
					Effect.map((result) => result.issues.nodes),
					withPolicy,
				);
			},

			replies: (questionIds) =>
				questionIds.length === 0
					? Effect.succeed([])
					: request(
							Schema.Struct({ comments: nodes(Reply) }),
							`query Replies($questionIds: [ID!]) {
								comments(first: ${MAX_PAGE_SIZE}, filter: { parent: { id: { in: $questionIds } } }) { nodes { ${COMMENT_FIELDS} } }
							}`,
							{ questionIds },
						).pipe(
							Effect.map((result) => result.comments.nodes),
							withPolicy,
						),

			comments: (issueId) => readComments(issueId).pipe(withPolicy),

			moveIssue: (issueId, stateId) =>
				request(
					Schema.Struct({ issueUpdate: Success }),
					`mutation Move($id: String!, $stateId: String!) {
						issueUpdate(id: $id, input: { stateId: $stateId }) { success }
					}`,
					{ id: issueId, stateId },
				).pipe(Effect.asVoid, withPolicy),

			comment: (issueId, comment, parentId) =>
				Effect.gen(function* () {
					const existing = (yield* readComments(issueId)).find((candidate) => hasMarker(candidate.body, comment.marker));

					if (existing) {
						return existing.id;
					}

					const result = yield* request(
						Schema.Struct({ commentCreate: Schema.Struct({ ...Success.fields, comment: Schema.Struct({ id: Schema.String }) }) }),
						`mutation Comment($issueId: String!, $body: String!, $parentId: String) {
							commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success comment { id } }
						}`,
						{ issueId, body: comment.body, parentId },
					);

					return result.commentCreate.comment.id;
				}).pipe(withPolicy),

			react: (commentId, emoji) =>
				Effect.gen(function* () {
					const { comment } = yield* request(
						Schema.Struct({ comment: Schema.Struct({ reactions: Schema.Array(Reaction) }) }),
						`query Reactions($id: String!) {
							comment(id: $id) { reactions { emoji } }
						}`,
						{ id: commentId },
					);

					if (comment.reactions.some((reaction) => reaction.emoji === emoji)) {
						return;
					}

					yield* request(
						Schema.Struct({ reactionCreate: Success }),
						`mutation React($commentId: String!, $emoji: String!) {
							reactionCreate(input: { commentId: $commentId, emoji: $emoji }) { success }
						}`,
						{ commentId, emoji },
					);
				}).pipe(withPolicy),

			addLabel: (issueId, teamId, name) =>
				Effect.gen(function* () {
					yield* request(
						Schema.Struct({ issueAddLabel: Success }),
						`mutation AddLabel($id: String!, $labelId: String!) {
							issueAddLabel(id: $id, labelId: $labelId) { success }
						}`,
						{ id: issueId, labelId: yield* labelId(teamId, name) },
					);
				}).pipe(withPolicy),

			removeLabel: (issueId, labelId) =>
				request(
					Schema.Struct({ issueRemoveLabel: Success }),
					`mutation RemoveLabel($id: String!, $labelId: String!) {
						issueRemoveLabel(id: $id, labelId: $labelId) { success }
					}`,
					{ id: issueId, labelId },
				).pipe(Effect.asVoid, withPolicy),
		});
	});

export class Linear extends Context.Service<Linear, LinearShape>()('herdr-linear/Linear') {
	static readonly layer = (endpoint = 'https://api.linear.app/graphql') => Layer.effect(Linear, make(endpoint));
}
