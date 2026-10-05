import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import { commandClaudeArgs, ctlPath } from './commands.ts';
import { Refused } from './ctl.ts';
import { deliveries, type Harness, makeHarness, markerKeys } from './test-harness.ts';

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

const commandTab = (h: Harness, identifier: string) => {
	const tab = h.herdr.tabs().find((candidate) => candidate.label === `@bot ${identifier}`);

	if (!tab) {
		throw new Error(`${identifier} has no tab`);
	}

	return tab;
};

const statuses = (h: Harness) => h.commands.pipe(Effect.map((commands) => commands.map((command) => command.status)));

describe('commands', () => {
	it.effect("runs one command at a time in the repo's clone, in a Claude locked down to the CLI and reading, with the service's environment", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number, comment } = yield* mention(h, '@orchestratorbot stop TEST-12 and start TEST-14');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot pause everything')));
			yield* h.tick;

			const tab = commandTab(h, 'CMD-1');
			const [start] = h.herdr.starts();

			assert.deepStrictEqual(yield* statuses(h), ['running', 'queued']);
			assert.deepStrictEqual([tab.cwd, tab.env.HERDR_PLUGIN_STATE_DIR, tab.env.HERDR_PLUGIN_CONFIG_DIR, tab.env.CLAUDE_CONFIG_PATH], [h.repo, h.dir, h.dir, join(h.dir, 'claude.json')]);
			assert.deepStrictEqual([start.paneId, start.name, start.args], [tab.paneId, 'cmd-1', commandClaudeArgs(ctlPath)]);
			assert.include(start.prompt, `You are CMD-1, the sapphire-agent command agent. @marioparaschiv mentioned the bot in ${comment.url} (test/repo#1) and wrote: "@orchestratorbot stop TEST-12 and start TEST-14".`);
			assert.isTrue(JSON.parse(readFileSync(join(h.dir, 'claude.json'), 'utf8')).projects[h.repo].hasTrustDialogAccepted);
			assert.deepStrictEqual(commandClaudeArgs('/srv/ctl.sh').slice(0, 5), ['--restricted', '--strict-mcp-config', '--tools', 'Bash,Read,Grep,Glob', '--settings']);
			assert.deepStrictEqual(JSON.parse(commandClaudeArgs('/srv/ctl.sh')[5]), {
				permissions: {
					defaultMode: 'dontAsk',
					allow: [
						'Bash(sh /srv/ctl.sh *)',
						...['gh pr view', 'gh pr diff', 'gh pr checks', 'gh issue view', 'git log', 'git show', 'git diff', 'git status'].flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]),
						'Read',
						'Grep',
						'Glob',
					],
					deny: ['Bash(git * --output*)'],
				},
			});

			assert.deepStrictEqual(yield* h.ctl('reply', comment.url, 'Stopped TEST-12; TEST-14 is next in line.'), [`the bot replies on ${comment.url} on the next tick`]);
			assert.deepStrictEqual(yield* h.ctl('done', 'cmd-1'), ['CMD-1 ends once its agent stops']);
			yield* h.tick;

			assert.deepStrictEqual(h.github.botComments(h.githubRepo, number), ['Stopped TEST-12; TEST-14 is next in line.\n\n<!-- sapphire-agent:CMD-1:commandReply:1 -->']);
			assert.deepStrictEqual(yield* statuses(h), ['running', 'queued']);

			h.herdr.setAgentStatus(tab.paneId, 'done');
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['ended', 'running']);
			assert.deepStrictEqual(h.herdr.closedTabs(), [tab.tabId]);
			assert.deepStrictEqual(
				h.herdr.starts().map(({ name }) => name),
				['cmd-1', 'cmd-2'],
			);
			assert.deepStrictEqual(yield* h.ctl('done', 'CMD-1').pipe(Effect.flip), new Refused({ message: 'CMD-1 is not in flight' }));
			assert.deepStrictEqual(yield* h.ctl('reply', 'https://github.com/test/repo/pull/1#issuecomment-404', 'Hi.').pipe(Effect.flip), new Refused({ message: 'https://github.com/test/repo/pull/1#issuecomment-404 is not a comment that mentioned the bot' }));
		}),
	);

	it.effect('accepts done from an agent that finished before its start was recorded, and ends the command once the start is', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, h.github.addComment(h.githubRepo, number, '@orchestratorbot what is running?')));
			h.herdr.crashAfterWrite(3, new Transient({ message: 'the process died' }));
			yield* h.tick;

			assert.deepStrictEqual(h.herdr.starts().map(({ name }) => name), ['cmd-1']);
			assert.deepStrictEqual(yield* statuses(h), ['claimed']);
			assert.deepStrictEqual(yield* h.ctl('done', 'CMD-1'), ['CMD-1 ends once its agent stops']);

			const tab = commandTab(h, 'CMD-1');

			h.herdr.setAgentStatus(tab.paneId, 'done');
			yield* h.restart;
			yield* h.tick;
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['ended']);
			assert.deepStrictEqual(h.herdr.closedTabs(), [tab.tabId]);
			assert.lengthOf(h.herdr.starts(), 1);
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

	it.effect('fails a command whose agent exits, goes quiet without saying it is done, stays stale after a nudge or runs over the cap, once, with its tab closed', () =>
		Effect.gen(function* () {
			const cases: ReadonlyArray<readonly [string, (h: Harness, paneId: string) => Effect.Effect<void>, string]> = [
				['exited', (h, paneId) => Effect.sync(() => h.herdr.setAgent(paneId, null)), 'CMD-1 exited, so I stopped it.'],
				[
					'quiet',
					(h, paneId) =>
						Effect.gen(function* () {
							h.herdr.setAgentStatus(paneId, 'idle');
							yield* h.tick;
							yield* TestClock.adjust('3 minutes');
						}),
					'CMD-1 stopped 3 min ago without saying it was done, so I stopped it.',
				],
				[
					'stale',
					(h, paneId) =>
						Effect.gen(function* () {
							h.herdr.setTail(paneId, '⏺ Reading the PR (12s · 3k tokens)');
							yield* h.tick;
							yield* TestClock.adjust('10 minutes');
							h.herdr.setTail(paneId, '⏺ Reading the PR (612s · 9k tokens)');
							yield* h.tick;
							assert.deepStrictEqual(h.herdr.prompts(), [{ paneId, text: 'continue' }]);
							yield* TestClock.adjust('10 minutes');
						}),
					'CMD-1 showed no new output for 20 min, even after a nudge, so I stopped it.',
				],
				[
					'over the cap',
					(h, paneId) =>
						Effect.gen(function* () {
							for (let minutes = 0; minutes < 91; minutes += 7) {
								h.herdr.setTail(paneId, `⏺ Step ${'.'.repeat(minutes)}`);
								yield* h.tick;
								yield* TestClock.adjust('7 minutes');
							}
						}),
					'CMD-1 ran for 91 min, over the 90 min cap, so I stopped it.',
				],
			];

			for (const [name, happen, notice] of cases) {
				const h = yield* makeHarness();
				const { number } = yield* mention(h, '@orchestratorbot what is running?');
				const tab = commandTab(h, 'CMD-1');

				yield* happen(h, tab.paneId);
				yield* h.tick;
				yield* h.restart;
				yield* h.tick;

				const [failed, ...others] = h.github.botComments(h.githubRepo, number);

				assert.deepStrictEqual(yield* statuses(h), ['error'], name);
				assert.deepStrictEqual(others, [], name);
				assert.isTrue(failed.startsWith(`**sapphire-agent** (\`error\`): ${notice}`), `${name}: ${failed}`);
				assert.deepStrictEqual(markerKeys([failed]), [`commandFailed:${(yield* h.commands)[0].claimedAt}`], name);
				assert.isTrue(Option.isNone(h.herdr.tab(tab.tabId)), name);
			}
		}),
	);

	it.effect('runs a command for a repo without a clone in the state directory, and fails it when Claude does not start', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			h.herdr.setStartBehaviour('no-agent');

			const { number } = yield* mention(h, '@orchestratorbot what is running?', 'acme/elsewhere');
			const [failed] = h.github.botComments('acme/elsewhere', number);
			const [command] = yield* h.commands;

			assert.deepStrictEqual([command.status, command.cwd], ['error', h.dir]);
			assert.isTrue(failed.startsWith('**sapphire-agent** (`error`): CMD-1 could not start: Claude did not start in '), failed);
			assert.include(failed, ': no agent is running, so I stopped it.');
			assert.deepStrictEqual(h.herdr.tabs(), []);
		}),
	);

	it.effect('fails a claimed command that is not confirmed running within the start timeout', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			h.herdr.crashAfterWrite(3, new Transient({ message: 'herdr is not answering' }));
			h.herdr.setStartBehaviour('no-agent');

			const { number } = yield* mention(h, '@orchestratorbot what is running?');

			assert.deepStrictEqual(yield* statuses(h), ['claimed']);

			yield* TestClock.adjust('5 minutes');
			yield* h.tick;

			assert.deepStrictEqual(yield* statuses(h), ['error']);
			assert.isTrue(h.github.botComments(h.githubRepo, number)[0].startsWith('**sapphire-agent** (`error`): CMD-1 was not confirmed running within 300 s'));
		}),
	);
});
