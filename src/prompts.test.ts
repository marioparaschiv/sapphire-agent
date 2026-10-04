import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Prompts } from './prompts.ts';

const withPrompts = <A>(use: (prompts: Prompts['Service']) => A) => Prompts.useSync(use).pipe(Effect.provide(Prompts.layer));

const epic = {
	identifier: 'HL-8',
	title: 'Rewrite the orchestrator on Effect 4 as a level-triggered reconciler',
	url: 'https://linear.app/marioparaschiv/issue/HL-8/rewrite-the-orchestrator-on-effect-4-as-a-level-triggered',
};

describe('Prompts', () => {
	it.effect('asks the orchestrate skill to run the epic in the worktree', () =>
		withPrompts((prompts) =>
			assert.strictEqual(
				prompts.orchestrate(epic),
				'/orchestrate the sub-issues of Linear epic HL-8 (https://linear.app/marioparaschiv/issue/HL-8/rewrite-the-orchestrator-on-effect-4-as-a-level-triggered) autonomously, in the worktree you are in.',
			),
		),
	);

	it.effect('asks the follow-up skill to answer the threads it was given', () =>
		withPrompts((prompts) =>
			assert.strictEqual(
				prompts.followUp(
					{ identifier: 'UNB-130', title: 'Ready to ship', url: 'https://linear.app/marioparaschiv/issue/UNB-130/ready-to-ship' },
					{ pullRequestUrl: 'https://github.com/marioparaschiv/unbound/pull/120', threadIds: ['PRRT_inline', 'PRRT_accepted_flag'], instruction: null },
				),
				'/follow-up Linear epic UNB-130 (https://linear.app/marioparaschiv/issue/UNB-130/ready-to-ship), PR https://github.com/marioparaschiv/unbound/pull/120, threads PRRT_inline PRRT_accepted_flag, autonomously, in the worktree you are in.',
			),
		),
	);

	it.effect('passes a follow-up its instruction quoted, with or without threads', () =>
		withPrompts((prompts) =>
			assert.strictEqual(
				prompts.followUp(
					{ identifier: 'UNB-130', title: 'Ready to ship', url: 'https://linear.app/marioparaschiv/issue/UNB-130/ready-to-ship' },
					{ pullRequestUrl: 'https://github.com/marioparaschiv/unbound/pull/120', threadIds: [], instruction: 'Use the "retry" helper.\nKeep the API.' },
				),
				'/follow-up Linear epic UNB-130 (https://linear.app/marioparaschiv/issue/UNB-130/ready-to-ship), PR https://github.com/marioparaschiv/unbound/pull/120, no threads, instruction "Use the \\"retry\\" helper.\\nKeep the API.", autonomously, in the worktree you are in.',
			),
		),
	);

	it.effect("gives a command's agent the comment as data on one line, its tools and how to finish", () =>
		withPrompts((prompts) => {
			const prompt = prompts.command({
				identifier: 'CMD-3',
				author: 'marioparaschiv',
				url: 'https://github.com/marioparaschiv/unbound/pull/120#issuecomment-9',
				repo: 'marioparaschiv/unbound',
				number: 120,
				body: '@orchestratorbot stop UNB-12\nthen start UNB-14',
				ctl: '/home/dev/herdr-linear/scripts/ctl.sh',
			});

			assert.notInclude(prompt, '\n');
			assert.include(prompt, 'You are CMD-3, the herdr-linear command agent. @marioparaschiv mentioned the bot in https://github.com/marioparaschiv/unbound/pull/120#issuecomment-9 (marioparaschiv/unbound#120) and wrote: "@orchestratorbot stop UNB-12\\nthen start UNB-14".');
			assert.include(prompt, '`sh /home/dev/herdr-linear/scripts/ctl.sh <subcommand>`');
			assert.include(prompt, 'reply https://github.com/marioparaschiv/unbound/pull/120#issuecomment-9 <text>; done CMD-3.');
			assert.isTrue(prompt.endsWith('then run done CMD-3.'));
			assert.strictEqual(prompts.commandTabLabel({ identifier: 'CMD-3' }), '@bot CMD-3');
		}),
	);

	it.effect('labels the tab with the identifier and the title, shortened past 40 characters', () =>
		withPrompts((prompts) => {
			assert.strictEqual(prompts.tabLabel(epic), 'HL-8 Rewrite the orchestrator on Effect 4 as…');
			assert.strictEqual(prompts.tabLabel({ identifier: 'HL-9', title: 'Exactly forty characters long title here' }), 'HL-9 Exactly forty characters long title here');
			assert.strictEqual(prompts.tabLabel({ identifier: 'HL-9', title: 'Add the foundation for the new orchestr ator' }), 'HL-9 Add the foundation for the new orchestr…');
		}),
	);
});
