import { assert, describe, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { Permanent, Transient } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { classifyGhFailure, GitHub, mentions } from './github.ts';
import { GitHubAppFixture } from './github-app-fixture.ts';
import { FakeGitHub } from './github-fake.ts';
import { withMarker } from './markers.ts';

type GhCall = { readonly args: ReadonlyArray<string>; readonly input: string; readonly env: Record<string, string | undefined> | undefined; readonly extendEnv: boolean | undefined };

type GhReply = { readonly stdout: string } | { readonly exitCode: number; readonly stderr: string } | 'hang';

const encoder = new TextEncoder();

const bytes = (text: string) => Stream.make(encoder.encode(text));

const config = AppConfig.layerTest('/tmp/sapphire-agent-test');

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
		thread: { isResolved: false, comments: ['Rename this to fetchUsers @orchestratorbot'] },
	};

	const respond = (call: GhCall): GhReply => {
		if (call.args[1] === '--method') {
			const request = Schema.decodeUnknownSync(RestRequest)(call.input);

			if (call.args[3] === `repos/${repo}/issues/7/comments`) {
				state.comments.push(request.body);

				return { stdout: JSON.stringify({ id: 2_400_000 + state.comments.length, body: request.body, user: { login: 'mario' } }) };
			}
		}

		const { query, variables } = graphqlRequest(call);

		if (query.includes('query ConversationBodies')) {
			return data({ repository: { issueOrPullRequest: { comments: page(state.comments) } } });
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

const summary = withMarker('Addressed your concerns inline.', { identifier: 'HL-11', purpose: 'addressed', key: '1759500000000' });

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

	it.effect("posts a comment once on an issue or PR, as the GitHub App with its installation's token", () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);
			const minted = yield* Effect.gen(function* () {
				const app = yield* GitHubAppFixture;

				app.install(repo);
				yield* GitHub.use((github) => Effect.repeat(github.postComment(repo, 7, summary), { times: 1 }));

				return app.tokens();
			}).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.comments, [summary.body]);
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

	it.effect('does not post the comment again when the write lands but times out', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const hung = Deferred.makeUnsafe<void>();
			const { layer } = liveWithGh((call) => {
				const reply = server.respond(call);

				if (call.args[1] === '--method' && server.state.comments.length === 1) {
					Deferred.doneUnsafe(hung, Effect.void);

					return 'hang';
				}

				return reply;
			});
			const context = yield* Layer.build(layer);

			Context.get(context, GitHubAppFixture).install(repo);
			const fiber = yield* Context.get(context, GitHub).postComment(repo, 7, summary).pipe(Effect.forkChild);

			// Minting the token is real I/O, so the clock only moves once the write is in flight.
			yield* Deferred.await(hung);
			yield* TestClock.adjust('20 seconds');
			yield* TestClock.adjust('1200 millis');
			yield* Fiber.join(fiber);

			assert.deepStrictEqual(server.state.comments, [summary.body]);
		}),
	);

	it.effect('fails Permanent without posting when the GitHub App is not installed on the repo', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);
			const exit = yield* GitHub.use((github) => github.postComment(repo, 7, summary)).pipe(Effect.provide(layer), Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(new Permanent({ message: `GitHub answered HTTP 404 to GET /repos/${repo}/installation: Not Found` })));
			assert.lengthOf(calls, 0);
		}),
	);

	it.effect('replies to a thread once and resolves it once, as the GitHub App', () =>
		Effect.gen(function* () {
			const server = pullRequestServer();
			const { calls, layer } = liveWithGh(server.respond);

			yield* Effect.gen(function* () {
				(yield* GitHubAppFixture).install(repo);
				yield* GitHub.use((github) =>
					Effect.repeat(Effect.andThen(github.replyToThread(repo, 'PRRT_kwDOA1', reply), github.resolveThread(repo, 'PRRT_kwDOA1')), { times: 1 }),
				);
			}).pipe(Effect.provide(layer));

			assert.deepStrictEqual(server.state.thread, { isResolved: true, comments: ['Rename this to fetchUsers @orchestratorbot', reply.body] });
			assert.deepStrictEqual(
				calls.map((call) => [/^(query|mutation) \w+/.exec(graphqlRequest(call).query)?.[0], call.env]),
				[
					['query ReviewThread', undefined],
					['mutation ReplyToThread', { GH_TOKEN: 'ghs_1001_1' }],
					['query ReviewThread', undefined],
					['mutation ResolveThread', { GH_TOKEN: 'ghs_1001_1' }],
					['query ReviewThread', undefined],
					['query ReviewThread', undefined],
				],
			);
			assert.deepStrictEqual(graphqlRequest(calls[1]).variables, { threadId: 'PRRT_kwDOA1', body: reply.body });
		}),
	);

	it.effect('refuses to look for a marker past the 100 newest comments', () =>
		Effect.gen(function* () {
			const { calls, layer } = liveWithGh(() =>
				data({ repository: { issueOrPullRequest: { comments: { totalCount: 140, nodes: Array.from({ length: 100 }, (_, n) => ({ body: `LGTM ${n}` })) } } } }),
			);
			const exit = yield* Effect.gen(function* () {
				(yield* GitHubAppFixture).install(repo);

				return yield* GitHub.use((github) => github.postComment(repo, 7, summary));
			}).pipe(Effect.provide(layer), Effect.exit);

			assert.deepStrictEqual(exit, Exit.fail(new Permanent({ message: `${repo}#7 comments has 140 entries, over the 100 one query reads` })));
			assert.lengthOf(calls, 1);
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
				github.postComment(repo, number, summary),
				github.replyToThread(repo, threadId, reply),
				github.resolveThread(repo, threadId),
			]);

			fake.crashAfterWrite(2, crash);
			assert.deepStrictEqual(yield* Effect.exit(post), Exit.fail(crash));
			yield* post;

			assert.deepStrictEqual(fake.botComments(repo, number), [summary.body]);
			assert.deepStrictEqual(
				[fake.thread(threadId).isResolved, fake.thread(threadId).comments.map(({ body }) => body)],
				[true, ['@orchestratorbot rename this', reply.body]],
			);
		}).pipe(Effect.provide(FakeGitHub.layer.pipe(Layer.provide(GitHubAppFixture.layer), Layer.provide(config)))),
	);
});
