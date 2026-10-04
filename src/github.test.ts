import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { asClaude, classifyGhFailure, GitHub, mentions, ON_BEHALF_OF_CLAUDE } from './github.ts';
import { GitHubAppFixture } from './github-app-fixture.ts';
import { FakeGitHub } from './github-fake.ts';
import { withMarker } from './markers.ts';

type GhCall = { readonly args: ReadonlyArray<string>; readonly input: string; readonly env: Record<string, string | undefined> | undefined; readonly extendEnv: boolean | undefined };

type GhReply = { readonly stdout: string } | { readonly exitCode: number; readonly stderr: string } | 'hang';

const encoder = new TextEncoder();

const bytes = (text: string) => Stream.make(encoder.encode(text));

const config = AppConfig.layerTest('/tmp/herdr-linear-test');

// The live layer over a fake `gh` that records each call and answers it with `respond`, with the GitHub App fixture.
const liveWithGh = (respond: (call: GhCall) => GhReply) => {
	const calls: Array<GhCall> = [];
	const spawner = ChildProcessSpawner.make((command) =>
		Effect.gen(function* () {
			if (command._tag !== 'StandardCommand' || command.command !== 'gh') {
				return yield* Effect.die(new Error('expected a gh command'));
			}

			const input = Stream.isStream(command.options.stdin) ? yield* command.options.stdin.pipe(Stream.decodeText(), Stream.mkString) : '';
			const call = { args: command.args, input, env: command.options.env, extendEnv: command.options.extendEnv };

			calls.push(call);
			const reply = respond(call);
			const stdout = reply !== 'hang' && 'stdout' in reply ? reply.stdout : '';
			const stderr = reply !== 'hang' && 'stderr' in reply ? reply.stderr : '';
			const exitCode = reply === 'hang' ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode('exitCode' in reply ? reply.exitCode : 0));

			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(4242),
				exitCode,
				isRunning: Effect.succeed(reply === 'hang'),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: reply === 'hang' ? Stream.never : bytes(stdout),
				stderr: reply === 'hang' ? Stream.never : bytes(stderr),
				all: reply === 'hang' ? Stream.never : bytes(stdout + stderr),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			});
		}),
	);

	return {
		calls,
		layer: GitHub.layer.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)), Layer.provideMerge(GitHubAppFixture.layer), Layer.provide(config)),
	};
};

const GraphqlRequest = Schema.fromJsonString(
	Schema.Struct({
		query: Schema.String,
		variables: Schema.Struct({ threadId: Schema.optionalKey(Schema.String), body: Schema.optionalKey(Schema.String) }),
	}),
);

const RestRequest = Schema.fromJsonString(
	Schema.Struct({
		body: Schema.String,
		event: Schema.optionalKey(Schema.String),
		comments: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Int, side: Schema.String, body: Schema.String }))),
	}),
);

const graphqlRequest = (call: GhCall) => Schema.decodeUnknownSync(GraphqlRequest)(call.input);

const data = (value: unknown) => ({ stdout: JSON.stringify({ data: value }) });

const page = (bodies: ReadonlyArray<string>) => ({ totalCount: bodies.length, nodes: bodies.map((body) => ({ body })) });

const repo = 'acme/web';

// GitHub as `gh` sees it for PR 7 of acme/web with one review thread.
const pullRequestServer = () => {
	const state = {
		comments: new Array<string>(),
		reviews: new Array<typeof RestRequest.Type>(),
		thread: { isResolved: false, comments: ['Rename this to fetchUsers @orchestratorbot'] },
	};

	const respond = (call: GhCall): GhReply => {
		if (call.args[1] === '--method') {
			const request = Schema.decodeUnknownSync(RestRequest)(call.input);

			if (call.args[3] === `repos/${repo}/issues/7/comments`) {
				state.comments.push(request.body);

				return { stdout: JSON.stringify({ id: 2_400_000 + state.comments.length, body: request.body, user: { login: 'mario' } }) };
			}

			state.reviews.push(request);

			return { stdout: JSON.stringify({ id: 3_100_000 + state.reviews.length, state: 'COMMENTED', body: request.body }) };
		}

		const { query, variables } = graphqlRequest(call);

		if (query.includes('query ConversationBodies')) {
			return data({ repository: { issueOrPullRequest: { comments: page(state.comments) } } });
		}

		if (query.includes('query PullRequestBodies')) {
			return query.includes('comments(last')
				? data({ repository: { pullRequest: { comments: page(state.comments) } } })
				: data({ repository: { pullRequest: { reviews: page(state.reviews.map(({ body }) => body)) } } });
		}

		if (query.includes('query ReviewThread')) {
			return data({ node: { isResolved: state.thread.isResolved, comments: page(state.thread.comments) } });
		}

		if (query.includes('mutation ReplyToThread') && variables.body !== undefined) {
			state.thread.comments.push(variables.body);

			return data({ addPullRequestReviewThreadReply: { comment: { id: `PRRC_kwDO${state.thread.comments.length}` } } });
		}

		if (query.includes('mutation ResolveThread')) {
			state.thread.isResolved = true;

			return data({ resolveReviewThread: { thread: { isResolved: true } } });
		}

		throw new Error(`unexpected gh call: ${call.args.join(' ')}`);
	};

	return { state, respond };
};

const summary = withMarker('Added the users import.\n\nReady for review, @mario.', { identifier: 'HL-11', purpose: 'summary', key: '1759500000000' });

const flagsReview = withMarker('Self-review findings I did not fix in this PR.', { identifier: 'HL-11', purpose: 'flags', key: '1759500000000' });

const flags = [
	{ path: 'src/users.ts', line: 12, body: 'This loads every user into memory.' },
	{ path: 'src/import.ts', line: 3, body: 'No retry on a failed page.' },
];

const reply = withMarker('Renamed it to fetchUsers.', { identifier: 'HL-11', purpose: 'reply', key: 'PRRT_kwDOA1.1759500000000' });

const pullRequestJson = (number: number, state: string) => ({
	number,
	url: `https://github.com/${repo}/pull/${number}`,
	state,
	author: { login: 'mario' },
	headRefName: 'mario/hl-11-github',
});

describe('GitHub live layer', () => {
	it.effect('finds the open PR first, else a merged one, else a closed one', () =>
		Effect.gen(function* () {
			const lists = [
				[pullRequestJson(3, 'CLOSED'), pullRequestJson(5, 'MERGED'), pullRequestJson(8, 'OPEN')],
				[pullRequestJson(3, 'CLOSED'), pullRequestJson(5, 'MERGED')],
				[pullRequestJson(3, 'CLOSED')],
				[],
			];
			const { calls, layer } = liveWithGh(() => ({ stdout: JSON.stringify(lists[calls.length - 1]) }));
			const found = yield* Effect.forEach(lists, () => GitHub.use((github) => github.findPullRequest(repo, 'mario/hl-11-github'))).pipe(Effect.provide(layer));

			assert.deepStrictEqual(
				found.map(Option.map(({ number, state }) => `${number} ${state}`)),
				[Option.some('8 OPEN'), Option.some('5 MERGED'), Option.some('3 CLOSED'), Option.none()],
			);
			assert.deepStrictEqual(calls[0].args, ['pr', 'list', '--repo', repo, '--head', 'mario/hl-11-github', '--state', 'all', '--json', 'number,url,state,author']);
		}),
	);

	it.effect('posts the summary once, as Claude, however often it is asked', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);

			yield* GitHub.use((github) => Effect.repeat(github.postSummary(repo, 7, summary), { times: 1 })).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.comments, [`${summary.body}\n\n${ON_BEHALF_OF_CLAUDE}`]);
			assert.deepStrictEqual(
				calls.map(({ args }) => args.join(' ')),
				['api graphql --input -', `api --method POST repos/${repo}/issues/7/comments --input -`, 'api graphql --input -'],
			);
		}),
	);

	it.effect('does not post the summary again when the write lands but times out', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { layer } = liveWithGh((call) => {
				const reply = server.respond(call);

				return call.args[1] === '--method' && server.state.comments.length === 1 ? 'hang' : reply;
			});
			const github = Context.get(yield* Layer.build(layer), GitHub);
			const fiber = yield* github.postSummary(repo, 7, summary).pipe(Effect.forkChild);

			yield* TestClock.adjust('20 seconds');
			yield* TestClock.adjust('1200 millis');
			yield* Fiber.join(fiber);

			assert.deepStrictEqual(server.state.comments, [asClaude(summary.body)]);
		}),
	);

	it.effect('posts every flag in one review once, each body as Claude', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { layer } = liveWithGh(server.respond);

			yield* GitHub.use((github) => Effect.repeat(github.postFlagsReview(repo, 7, flagsReview, flags), { times: 1 })).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.reviews, [
				{
					event: 'COMMENT',
					body: asClaude(flagsReview.body),
					comments: [
						{ path: 'src/users.ts', line: 12, side: 'RIGHT', body: asClaude('This loads every user into memory.') },
						{ path: 'src/import.ts', line: 3, side: 'RIGHT', body: asClaude('No retry on a failed page.') },
					],
				},
			]);
		}),
	);

	it.effect("posts as the GitHub App once on an issue or PR, with its installation's token", () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);
			const reply = withMarker('Stopped HL-12.', { identifier: 'CMD-3', purpose: 'commandReply', key: '7' });
			const minted = yield* Effect.gen(function* () {
				const app = yield* GitHubAppFixture;

				app.install(repo);
				yield* GitHub.use((github) => Effect.repeat(github.postAsBot(repo, 7, reply), { times: 1 }));

				return app.tokens();
			}).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.comments, [reply.body]);
			assert.deepStrictEqual(
				minted.map(({ token }) => token),
				['ghs_1001_1'],
			);
			assert.deepStrictEqual(
				calls.map(({ args, env, extendEnv }) => [args.join(' '), env, extendEnv]),
				[
					['api graphql --input -', undefined, undefined],
					[`api --method POST repos/${repo}/issues/7/comments --input -`, { GH_TOKEN: 'ghs_1001_1' }, true],
					['api graphql --input -', undefined, undefined],
				],
			);
			assert.match(graphqlRequest(calls[0]).query, /issueOrPullRequest\(number: \$number\)/);
		}),
	);

	it.effect('fails Permanent without posting when the GitHub App is not installed on the repo', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);
			const reply = withMarker('Stopped HL-12.', { identifier: 'CMD-3', purpose: 'commandReply', key: '7' });
			const exit = yield* GitHub.use((github) => github.postAsBot(repo, 7, reply)).pipe(Effect.provide(layer), Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(new Permanent({ message: `GitHub answered HTTP 404 to GET /repos/${repo}/installation: Not Found` })));
			assert.lengthOf(calls, 0);
		}),
	);

	it.effect('replies to a thread once and resolves it once', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);

			yield* GitHub.use((github) =>
				Effect.repeat(Effect.andThen(github.replyToThread('PRRT_kwDOA1', reply), github.resolveThread('PRRT_kwDOA1')), { times: 1 }),
			).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.thread, { isResolved: true, comments: ['Rename this to fetchUsers @orchestratorbot', asClaude(reply.body)] });
			assert.deepStrictEqual(
				calls.map((call) => /^(query|mutation) \w+/.exec(graphqlRequest(call).query)?.[0]),
				['query ReviewThread', 'mutation ReplyToThread', 'query ReviewThread', 'mutation ResolveThread', 'query ReviewThread', 'query ReviewThread'],
			);
			assert.deepStrictEqual(graphqlRequest(calls[1]).variables, { threadId: 'PRRT_kwDOA1', body: asClaude(reply.body) });
		}),
	);

	it.effect('refuses to look for a marker past the 100 newest comments', () =>
		Effect.gen(function* () {
			const { calls, layer } = liveWithGh(() =>
				data({ repository: { pullRequest: { comments: { totalCount: 140, nodes: Array.from({ length: 100 }, (_, n) => ({ body: `LGTM ${n}` })) } } } }),
			);
			const exit = yield* GitHub.use((github) => github.postSummary(repo, 7, summary)).pipe(Effect.provide(layer), Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(new Permanent({ message: `${repo}#7 comments has 140 entries, over the 100 one query reads` })));
			assert.lengthOf(calls, 1);
		}),
	);

	it.effect("reads the bot's unread notifications through its gh config dir, with the number of each issue or PR", () =>
		Effect.gen(function* () {
			const notification = (id: string, type: string, url: string | null, lastReadAt: string | null) => ({
				id,
				unread: true,
				reason: 'mention',
				updated_at: '2026-10-04T09:40:00Z',
				last_read_at: lastReadAt,
				subject: { title: 'Sync plugin settings', url, latest_comment_url: null, type },
				repository: { full_name: repo },
			});
			const { calls, layer } = liveWithGh(() => ({
				stdout: JSON.stringify([
					notification('18', 'PullRequest', `https://api.github.com/repos/${repo}/pulls/7`, '2026-10-04T09:30:00Z'),
					notification('19', 'Issue', `https://api.github.com/repos/${repo}/issues/12`, null),
					notification('20', 'Release', null, null),
				]),
			}));
			const found = yield* GitHub.use((github) => Effect.andThen(github.notifications, (unread) => github.markNotificationRead('18').pipe(Effect.as(unread)))).pipe(
				Effect.provide(layer),
			);

			assert.deepStrictEqual(found, [
				{ threadId: '18', repo, number: 7, lastReadAt: Option.some(Date.UTC(2026, 9, 4, 9, 30)) },
				{ threadId: '19', repo, number: 12, lastReadAt: Option.none() },
			]);
			assert.deepStrictEqual(
				calls.map(({ args, env }) => [args.join(' '), env]),
				[
					['api notifications?participating=true&per_page=50', { GH_CONFIG_DIR: '/tmp/herdr-linear-test/gh-bot' }],
					['api --method PATCH notifications/threads/18', { GH_CONFIG_DIR: '/tmp/herdr-linear-test/gh-bot' }],
				],
			);
		}),
	);

	it.effect("reads the comments, reviews and review comments of a PR and the comments of an issue, with an App's login as `<slug>[bot]`", () =>
		Effect.gen(function* () {
			const comment = (id: string, body: string, author: string | null = 'marioparaschiv', type = 'User') => ({
				id,
				url: `https://github.com/${repo}/pull/7#${id}`,
				body,
				createdAt: '2026-10-04T09:40:00Z',
				author: author === null ? null : { __typename: type, login: author },
			});
			const { calls, layer } = liveWithGh((call) =>
				call.input.includes('"number":7')
					? data({
							repository: {
								issueOrPullRequest: {
									comments: { nodes: [comment('IC_1', '@orchestratorbot stop HL-12'), comment('IC_3', 'Stopped HL-12.', 'orchestratorbot', 'Bot')] },
									reviews: { nodes: [{ ...comment('PRR_1', 'A few things. @orchestratorbot'), comments: { nodes: [comment('PRRC_1', 'Rename this.', null)] } }] },
								},
							},
						})
					: data({ repository: { issueOrPullRequest: call.input.includes('"number":12') ? { comments: { nodes: [comment('IC_2', '@orchestratorbot start HL-14')] } } : null } }),
			);
			const [pullRequest, issue, missing] = yield* GitHub.use((github) =>
				Effect.all([github.conversation(repo, 7), github.conversation(repo, 12), github.conversation(repo, 99).pipe(Effect.flip)]),
			).pipe(Effect.provide(layer));

			assert.deepStrictEqual(
				pullRequest.map(({ id, author }) => [id, author?.login ?? null]),
				[
					['IC_1', 'marioparaschiv'],
					['IC_3', 'orchestratorbot[bot]'],
					['PRR_1', 'marioparaschiv'],
					['PRRC_1', null],
				],
			);
			assert.deepStrictEqual(issue.map(({ id }) => id), ['IC_2']);
			assert.deepStrictEqual(missing, new Permanent({ message: `${repo}#99 is no issue or PR` }));
			assert.match(graphqlRequest(calls[0]).query, /reviews\(last: 100\) \{ nodes \{ id url body createdAt author \{ __typename login \} comments\(first: 100\)/);
		}),
	);

	it.effect('retries a gh call that times out as Transient', () =>
		Effect.gen(function* () {
			const { calls, layer } = liveWithGh(() => (calls.length === 1 ? 'hang' : { stdout: JSON.stringify([pullRequestJson(8, 'OPEN')]) }));
			const github = Context.get(yield* Layer.build(layer), GitHub);
			const fiber = yield* github.findPullRequest(repo, 'mario/hl-11-github').pipe(Effect.forkChild);

			yield* TestClock.adjust('20 seconds');
			assert.lengthOf(calls, 1);
			yield* TestClock.adjust('1200 millis');

			assert.deepStrictEqual(Option.map(yield* Fiber.join(fiber), ({ number }) => number), Option.some(8));
			assert.lengthOf(calls, 2);
		}),
	);

	it.effect('fails an unknown repo as Permanent without retrying', () =>
		Effect.gen(function* () {
			const stderr = "GraphQL: Could not resolve to a Repository with the name 'acme/missing'. (repository)\n";
			const { calls, layer } = liveWithGh(() => ({ exitCode: 1, stderr }));
			const exit = yield* GitHub.use((github) => github.findPullRequest('acme/missing', 'mario/hl-11-github')).pipe(Effect.provide(layer), Effect.exit);

			assert.deepStrictEqual(
				exit,
				Exit.fail(
					new Permanent({
						message: `gh pr list --repo acme/missing --head mario/hl-11-github --state all --json number,url,state,author exited with 1: ${stderr.trim()}`,
					}),
				),
			);
			assert.lengthOf(calls, 1);
		}),
	);

	it.effect('fails output that does not match the schema as Permanent', () =>
		Effect.gen(function* () {
			const { layer } = liveWithGh(() => ({ stdout: JSON.stringify([pullRequestJson(8, 'DRAFT')]) }));
			const error = yield* GitHub.use((github) => github.findPullRequest(repo, 'mario/hl-11-github')).pipe(Effect.provide(layer), Effect.flip);

			assert.strictEqual(error._tag, 'Permanent');
			assert.strictEqual(
				error.message,
				'gh pr list --repo acme/web --head mario/hl-11-github --state all --json number,url,state,author: Expected "OPEN" | "CLOSED" | "MERGED"\n  at [0]["state"]',
			);
		}),
	);
});

describe('mentions', () => {
	it('counts a mention of the bot only as a whole word, in any case', () => {
		const bodies = [
			'@OrchestratorBot rename this',
			'Rename this (@orchestratorbot).',
			'Rename this.\n@orchestratorbot',
			'@orchestratorbotx rename this',
			'@orchestratorbot-dev rename this',
			'mail me at mario@orchestratorbot',
			'orchestratorbot rename this',
		];

		assert.deepStrictEqual(
			bodies.filter((body) => mentions('orchestratorbot', body)),
			['@OrchestratorBot rename this', 'Rename this (@orchestratorbot).', 'Rename this.\n@orchestratorbot'],
		);
	});
});

describe('classifyGhFailure', () => {
	it('treats network errors, 5xx and rate limits as Transient and other failures as Permanent', () => {
		const cases = [
			['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'Transient'],
			['HTTP 502: Bad Gateway (https://api.github.com/graphql)', 'Transient'],
			['Post "https://api.github.com/graphql": read tcp 10.0.0.2:51234->140.82.121.6:443: read: connection reset by peer', 'Transient'],
			['HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/repos/acme/web/issues/7/comments)', 'Transient'],
			["GraphQL: Could not resolve to a Repository with the name 'acme/missing'. (repository)", 'Permanent'],
			['HTTP 404: Not Found (https://api.github.com/repos/acme/web/issues/7/comments)', 'Permanent'],
			['HTTP 422: Unprocessable Entity (https://api.github.com/repos/acme/web/pulls/7/reviews)\nPull request review thread line must be part of the diff', 'Permanent'],
			['GraphQL: Could not resolve to a node with the global id of \'PRRT_gone\' (node)', 'Permanent'],
		] as const;

		for (const [stderr, tag] of cases) {
			assert.strictEqual(classifyGhFailure('gh api graphql --input -', 1, stderr)._tag, tag, stderr);
		}
	});
});

describe('FakeGitHub', () => {
	it.effect("notifies the bot of a mention by anyone but itself, until it reads the notification, and lists the PR's comments, the App's included", () =>
		Effect.gen(function* () {
			const fake = yield* FakeGitHub;
			const github = yield* GitHub;
			const { number } = fake.addPullRequest({ repo, branch: 'mario/hl-11-github', author: 'marioparaschiv' });

			fake.addComment(repo, number, 'Looks good.');
			assert.deepStrictEqual(yield* github.notifications, []);

			const thread = fake.addThread(repo, number, { comments: [{ body: 'Rename this. @OrchestratorBot' }] });
			const [unread] = yield* github.notifications;

			yield* github.markNotificationRead(unread.threadId);
			assert.deepStrictEqual(yield* github.notifications, []);

			yield* github.postAsBot(repo, number, withMarker('On it.', { identifier: 'CMD-1', purpose: 'commandReply', key: '1' }));
			assert.deepStrictEqual(yield* github.notifications, []);

			fake.addReview(repo, number, '@orchestratorbot handle these', 'reviewer');

			assert.deepStrictEqual(
				(yield* github.notifications).map(({ threadId, number: notified, lastReadAt }) => [threadId, notified, Option.isSome(lastReadAt)]),
				[[unread.threadId, number, true]],
			);
			assert.deepStrictEqual(
				(yield* github.conversation(repo, number)).map(({ body, author }) => [body.split('\n')[0], author?.login]),
				[
					['Looks good.', 'marioparaschiv'],
					['On it.', 'orchestratorbot[bot]'],
					['@orchestratorbot handle these', 'reviewer'],
					['Rename this. @OrchestratorBot', 'marioparaschiv'],
				],
			);
			assert.deepStrictEqual(fake.thread(thread).comments.map(({ body }) => body), ['Rename this. @OrchestratorBot']);
		}).pipe(Effect.provide(FakeGitHub.layer.pipe(Layer.provide(GitHubAppFixture.layer), Layer.provide(config)))),
	);

	it.effect('finds the open PR first, as the live layer does', () =>
		Effect.gen(function* () {
			const fake = yield* FakeGitHub;
			const github = yield* GitHub;
			const merged = fake.addPullRequest({ repo, branch: 'mario/hl-11-github', state: 'MERGED' });
			const open = fake.addPullRequest({ repo, branch: 'mario/hl-11-github', author: 'mario' });

			assert.deepStrictEqual(yield* github.findPullRequest(repo, 'mario/hl-11-github'), Option.some(open));

			fake.setPullRequestState(repo, open.number, 'CLOSED');

			assert.deepStrictEqual(yield* github.findPullRequest(repo, 'mario/hl-11-github'), Option.some(merged));
		}).pipe(Effect.provide(FakeGitHub.layer.pipe(Layer.provide(GitHubAppFixture.layer), Layer.provide(config)))),
	);

	it.effect('does not post again after a crash between the write and recording it', () =>
		Effect.gen(function* () {
			const fake = yield* FakeGitHub;
			const github = yield* GitHub;
			const { number } = fake.addPullRequest({ repo, branch: 'mario/hl-11-github' });
			const threadId = fake.addThread(repo, number, { comments: [{ body: '@orchestratorbot rename this' }] });
			const crash = new Transient({ message: 'killed' });
			const post = Effect.all([
				github.postSummary(repo, number, summary),
				github.postFlagsReview(repo, number, flagsReview, flags),
				github.replyToThread(threadId, reply),
				github.resolveThread(threadId),
			]);

			fake.crashAfterWrite(2, crash);
			assert.deepStrictEqual(yield* Effect.exit(post), Exit.fail(crash));
			yield* post;

			assert.deepStrictEqual(fake.comments(repo, number), [asClaude(summary.body)]);
			assert.lengthOf(fake.reviews(repo, number), 1);
			assert.deepStrictEqual(
				[fake.thread(threadId).isResolved, fake.thread(threadId).comments.map(({ body }) => body)],
				[true, ['@orchestratorbot rename this', asClaude(reply.body)]],
			);
		}).pipe(Effect.provide(FakeGitHub.layer.pipe(Layer.provide(GitHubAppFixture.layer), Layer.provide(config)))),
	);
});
