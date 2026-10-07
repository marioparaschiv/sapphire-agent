import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { Refused } from './ctl.ts';
import { deliveries, git, type Harness, makeHarness, markerKeys } from './test-harness.ts';

const branch = 'mario/test-10-plugin-settings-sync';

// A PR on `repo` with a comment of the user's that mentions the bot, delivered to the webhook, and one tick.
const mention = (h: Harness, body: string, repo = h.githubRepo) =>
	Effect.gen(function* () {
		const { number } = h.github.addPullRequest({ repo, branch, author: 'marioparaschiv' });
		const comment = h.github.addComment(repo, number, body);

		yield* h.deliver(deliveries.issueComment(repo, number, comment));
		yield* h.tick;

		return { number, comment };
	});

const statuses = (h: Harness) => h.commands.pipe(Effect.map((commands) => commands.map((command) => command.status)));

describe('commands', () => {
	it.effect("gives each allowed user's mention a thumbs-up as soon as it is seen, while it still waits for its turn, and none to an ignored one", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number, comment: first } = yield* mention(h, '@orchestratorbot what is running?');
			const second = h.github.addComment(h.githubRepo, number, '@orchestratorbot pause everything');
			const stranger = h.github.addComment(h.githubRepo, number, '@orchestratorbot merge this', 'stranger');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, second));
			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, stranger));
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['running', 'queued', 'ignored']);
			assert.deepStrictEqual([first, second, stranger].map(({ id }) => h.github.hasThumbsUp(id)), [true, true, false]);
			assert.deepStrictEqual(
				(yield* h.commands).map(({ acknowledgedAt }) => acknowledgedAt !== null),
				[true, true, false],
			);

			const writes = h.github.writes();

			yield* h.tick;
			assert.strictEqual(h.github.writes(), writes);
		}),
	);

	it.effect('starts a command whose thumbs-up failed for now, and gives it one on a later tick', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });
			const comment = h.github.addComment(h.githubRepo, number, '@orchestratorbot what is running?');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, comment));
			h.github.crashAfterWrite(1, new Transient({ message: 'HTTP 502: Bad Gateway' }));
			yield* h.tick;

			const [started] = yield* h.commands;

			assert.deepStrictEqual([started.status, started.acknowledgedAt], ['running', null]);

			yield* h.tick;

			const [acknowledged] = yield* h.commands;

			assert.deepStrictEqual([acknowledged.status, acknowledged.acknowledgedAt !== null, h.github.hasThumbsUp(comment.id)], ['running', true, true]);
		}),
	);

	it.effect('posts a reply once when the process dies right after posting it', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number, comment } = yield* mention(h, '@orchestratorbot what is running?');

			yield* h.ctl('reply', comment.url, 'Nothing is running.');
			h.github.crashAfterWrite(1, new Transient({ message: 'the process died' }));
			yield* h.tick;
			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(markerKeys(h.github.botComments(h.githubRepo, number)), ['commandReply:1']);
		}),
	);


	it.effect('runs one command at a time, the next once the one before is done and its thread stopped', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number, comment } = yield* mention(h, '@orchestratorbot stop TEST-12 and start TEST-14');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot pause everything')));
			yield* h.tick;

			const [command] = yield* h.commands;

			assert.deepStrictEqual(yield* statuses(h), ['running', 'queued']);
			assert.deepStrictEqual((yield* h.t3.launches).map(({ title }) => title), ['CMD-1']);
			assert.isNotNull(command.threadId);

			assert.deepStrictEqual(yield* h.ctl('reply', comment.url, 'Stopped TEST-12; TEST-14 is next in line.'), [`the bot replies on ${comment.url} on the next tick`]);
			assert.deepStrictEqual(yield* h.ctl('done', 'cmd-1'), ['CMD-1 ends once its agent stops']);
			yield* h.t3.setRunStatus(command.threadId, 'running');
			yield* h.tick;

			assert.deepStrictEqual(h.github.botComments(h.githubRepo, number), ['Stopped TEST-12; TEST-14 is next in line.\n\n<!-- sapphire-agent:CMD-1:commandReply:1 -->']);
			assert.deepStrictEqual(yield* statuses(h), ['running', 'queued']);

			yield* h.t3.setRunStatus(command.threadId, 'completed');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['ended', 'running']);
			assert.deepStrictEqual((yield* h.t3.launches).map(({ title }) => title), ['CMD-1', 'CMD-2']);
			assert.deepStrictEqual(yield* h.ctl('done', 'CMD-1').pipe(Effect.flip), new Refused({ message: 'CMD-1 is not in flight' }));
			assert.deepStrictEqual(yield* h.ctl('reply', 'https://github.com/test/repo/pull/1#issuecomment-404', 'Hi.').pipe(Effect.flip), new Refused({ message: 'https://github.com/test/repo/pull/1#issuecomment-404 is not a comment that mentioned the bot' }));
		}),
	);

	it.effect('accepts done from an agent that finished before its thread was recorded, and ends the command once its thread is found by its title', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot what is running?')));
			// The thumbs-up, the claim and the checkout come first; the launched thread is the fourth write.
			h.crashAtJournalWrite(4);
			yield* h.tick;

			assert.isTrue(h.crashed());
			assert.deepStrictEqual(yield* statuses(h), ['claimed']);
			assert.lengthOf(yield* h.t3.launches, 1);
			assert.deepStrictEqual(yield* h.ctl('done', 'CMD-1'), ['CMD-1 ends once its agent stops']);

			yield* h.restart;
			yield* h.tick;

			const [command] = yield* h.commands;

			assert.deepStrictEqual(command.status, 'running');
			assert.isNotNull(command.threadId);
			yield* h.t3.setRunStatus(command.threadId, 'completed');
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['ended']);
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);

	it.effect('runs a command for a repo without a clone in the state directory, and fails it when T3 refuses the launch', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* h.t3.setLaunchOutcome({ code: 'runtime_mode_escalation_denied', message: 'The token may not launch threads here.' });

			const { number } = yield* mention(h, '@orchestratorbot what is running?', 'acme/elsewhere');
			const [failed] = h.github.botComments('acme/elsewhere', number);
			const [command] = yield* h.commands;
			const [launch] = yield* h.t3.launches;

			assert.deepStrictEqual([command.status, command.cwd], ['error', join(h.dir, 'commands')]);
			assert.deepStrictEqual(launch.workspaceStrategy, { type: 'root' });
			assert.isTrue(
				failed.startsWith('**sapphire-agent** (`error`): CMD-1 could not start: T3 refused t3_thread_launch: The token may not launch threads here. (runtime_mode_escalation_denied), so I stopped it.'),
				failed,
			);
		}),
	);

	it.effect('fails a claimed command that is not confirmed running within the start timeout', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* h.t3.rejectToken(true);

			const { number } = yield* mention(h, '@orchestratorbot what is running?');

			assert.deepStrictEqual(yield* statuses(h), ['claimed']);

			yield* TestClock.adjust('5 minutes');
			yield* h.t3.rejectToken(false);
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['error']);
			assert.isTrue(h.github.botComments(h.githubRepo, number)[0].startsWith('**sapphire-agent** (`error`): CMD-1 was not confirmed running within 300 s'));
			assert.deepStrictEqual(yield* h.t3.launches, []);
		}),
	);

	it.effect('fails a command whose thread runs over the cap, once', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = yield* mention(h, '@orchestratorbot what is running?');
			const [command] = yield* h.commands;

			assert.isNotNull(command.threadId);
			yield* h.t3.setRunStatus(command.threadId, 'running');

			for (let minutes = 0; minutes < 91; minutes += 7) {
				yield* h.tick;
				yield* TestClock.adjust('7 minutes');
			}

			yield* h.tick;
			yield* h.restart;
			yield* h.tick;

			const [failed, ...others] = h.github.botComments(h.githubRepo, number);

			assert.deepStrictEqual(others, []);
			assert.isTrue(failed.startsWith('**sapphire-agent** (`error`): CMD-1 ran for 91 min, over the 90 min cap, so I stopped it.'), failed);
			assert.deepStrictEqual(markerKeys([failed]), [`commandFailed:${command.claimedAt}`]);
			assert.deepStrictEqual(yield* statuses(h), ['error']);
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(command.threadId), ({ settled }) => settled), Option.some(true));
		}),
	);
	it.effect('runs a mention as one supervised T3 thread in a read-only checkout of the repo, posts its reply as the GitHub App and settles the thread once it is done', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number, comment } = yield* mention(h, '@orchestratorbot what is running?');
			const checkout = join(h.dir, 'commands', 'repo');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, comment));
			yield* h.tick;

			const [project] = yield* h.t3.projects;
			const [launch, ...others] = yield* h.t3.launches;
			const [command] = yield* h.commands;

			assert.deepStrictEqual(others, []);
			assert.deepStrictEqual(project.workspaceRoot, h.repo);
			assert.deepStrictEqual([launch.projectId, launch.title, launch.runtimeMode, launch.workspaceStrategy], [project.id, 'CMD-1', 'approval-required', { type: 'existing_worktree', worktreePath: checkout }]);
			assert.match(launch.message ?? '', /^You are CMD-1, the sapphire-agent command agent\. @marioparaschiv mentioned the bot in /);
			assert.deepStrictEqual([command.status, command.cwd, command.threadId !== null], ['running', checkout, true]);
			assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), git(h.repo, 'rev-parse', 'origin/main'));
			assert.isTrue(h.github.hasThumbsUp(comment.id));

			assert.isNotNull(command.threadId);
			yield* h.ctl('reply', comment.url, 'Nothing is running.');
			yield* h.ctl('done', 'CMD-1');
			yield* h.t3.setRunStatus(command.threadId, 'running');
			yield* h.tick;

			assert.deepStrictEqual(h.github.botComments(h.githubRepo, number), ['Nothing is running.\n\n<!-- sapphire-agent:CMD-1:commandReply:1 -->']);
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			yield* h.t3.setRunStatus(command.threadId, 'completed');
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['ended']);
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(command.threadId), ({ settled }) => settled), Option.some(true));
			assert.lengthOf(yield* h.t3.launches, 1);
		}),
	);

	it.effect("starts nothing for an ignored user's mention or a repeated delivery", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });
			const stranger = h.github.addComment(h.githubRepo, number, '@orchestratorbot dispatch TEST-14', 'octocat');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, stranger));
			yield* h.tick;
			assert.deepStrictEqual(yield* h.t3.launches, []);

			const { comment } = yield* mention(h, '@orchestratorbot pause everything');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, comment));
			yield* h.tick;

			assert.lengthOf(yield* h.t3.launches, 1);
			assert.deepStrictEqual(yield* statuses(h), ['ignored', 'running']);
		}),
	);

	it.effect('fails a command whose thread stopped without saying it was done: one reply as the bot, its thread interrupted and settled', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = yield* mention(h, '@orchestratorbot what is running?');
			const [command] = yield* h.commands;

			assert.isNotNull(command.threadId);
			yield* h.t3.setRunStatus(command.threadId, 'completed');
			yield* TestClock.adjust('179 seconds');
			yield* h.tick;
			assert.deepStrictEqual(yield* statuses(h), ['running']);

			yield* TestClock.adjust('1 second');
			yield* h.tick;
			yield* h.tick;

			const [failed, ...others] = h.github.botComments(h.githubRepo, number);

			assert.deepStrictEqual(others, []);
			assert.isTrue(failed.startsWith('**sapphire-agent** (`error`): CMD-1 stopped 3 min ago without saying it was done, so I stopped it.'));
			assert.deepStrictEqual(yield* statuses(h), ['error']);
			assert.deepStrictEqual(Option.map(yield* h.t3.thread(command.threadId), ({ settled }) => settled), Option.some(true));
		}),
	);
});
