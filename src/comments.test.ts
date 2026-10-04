import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { Comments, type FlaggedRun, replyMismatch } from './comments.ts';
import { AppConfig } from './config.ts';
import { type MarkedComment, parseMarker } from './markers.ts';

const minute = 60_000;
const claimedAt = 1_791_000_000_000;

const run: FlaggedRun = {
	identifier: 'UNB-12',
	claimedAt,
	tabLabel: 'UNB-12 Plugin settings sync',
	tabId: 'w2:t3',
	paneId: 'w2:p5',
	worktreePath: '/home/dev/.herdr/worktrees/unbound/mario-unb-12-plugin-settings-sync',
	branch: 'mario/unb-12-plugin-settings-sync',
	agentStatus: 'blocked',
	agentStatusSince: claimedAt + 30 * minute,
	tail: '⏺ The sync needs a conflict rule:\n\n  ```ts\n  merge(local, remote)\n  ```\n\n❯ Which should win, local or remote?',
	now: claimedAt + 34 * minute,
};

const tailBlock = `\`\`\`
⏺ The sync needs a conflict rule:

  '''ts
  merge(local, remote)
  '''

❯ Which should win, local or remote?
\`\`\``;

const runDetails = `- Tab: \`UNB-12 Plugin settings sync\` (w2:t3), pane w2:p5
- Worktree: \`/home/dev/.herdr/worktrees/unbound/mario-unb-12-plugin-settings-sync\` on branch \`mario/unb-12-plugin-settings-sync\``;

const startOver = 'Remove the label and move the epic back to Ready For Agent to start over.';

const withComments = <A>(use: (comments: Comments['Service']) => A) =>
	Comments.useSync(use).pipe(Effect.provide(Comments.layer), Effect.provide(AppConfig.layerTest('/tmp/herdr-linear-test')));

const assertComment = (comment: MarkedComment, text: string, marker: string) => {
	assert.strictEqual(comment.body, `${text}\n\n${marker}`);
	assert.deepStrictEqual(parseMarker(comment.body), Option.some(comment.marker));
};

describe('Comments', () => {
	it.effect('flags an agent waiting for input with the pane tail and how to answer it', () =>
		withComments((comments) =>
			assertComment(
				comments.awaitingInput(run),
				`**herdr-linear** (\`awaitingInput\`): the agent has been waiting for input for 4 min before writing its result file.

${runDetails}

Last lines of the pane:

${tailBlock}

The epic keeps the \`agent-stuck\` label. Reply to this comment and the reply is typed into the agent's pane. Or: ${startOver}`,
				'<!-- herdr-linear:UNB-12:awaitingInput:1791000000000-1791001800000 -->',
			),
		),
	);

	it.effect('gives a later question in the same run its own marker', () =>
		withComments((comments) => {
			const later = comments.awaitingInput({ ...run, agentStatus: 'idle', agentStatusSince: claimedAt + 50 * minute, now: claimedAt + 54 * minute });

			assert.strictEqual(comments.awaitingInput(run).marker.key, '1791000000000-1791001800000');
			assert.strictEqual(later.marker.key, '1791000000000-1791003000000');
			assert.isTrue(later.body.startsWith('**herdr-linear** (`awaitingInput`): the agent has been idle for 4 min before writing its result file.'));
		}),
	);

	it.effect('flags a stale agent after the nudge', () =>
		withComments((comments) =>
			assertComment(
				comments.stale({ ...run, agentStatus: 'working', agentStatusSince: claimedAt + 10 * minute, now: claimedAt + 30 * minute, nudgedAt: claimedAt + 20 * minute }),
				`**herdr-linear** (\`stale\`): the agent has shown no new output for 20 min, even after a nudge before writing its result file.

${runDetails}

Last lines of the pane:

${tailBlock}

The epic keeps the \`agent-stuck\` label. Look at the agent in its tab. Or: ${startOver}`,
				'<!-- herdr-linear:UNB-12:stale:1791000000000-1791001200000 -->',
			),
		),
	);

	it.effect('flags an agent that exited or vanished as an error', () =>
		withComments((comments) => {
			assertComment(
				comments.agentStopped({ ...run, agentStatus: 'exited' }),
				`**herdr-linear** (\`error\`): the agent exited before writing its result file.

${runDetails}

Last lines of the pane:

${tailBlock}

The epic keeps the \`agent-stuck\` label. ${startOver}`,
				'<!-- herdr-linear:UNB-12:error:1791000000000 -->',
			);
			assert.isTrue(
				comments
					.agentStopped({ ...run, agentStatus: 'vanished', tail: '' })
					.body.startsWith('**herdr-linear** (`error`): the agent disappeared (its tab was closed or herdr restarted) before writing its result file.'),
			);
		}),
	);

	it.effect('flags a run over the wall-clock cap', () =>
		withComments((comments) =>
			assertComment(
				comments.overCap({ identifier: 'UNB-12', claimedAt, status: 'running', tail: '✻ Running tests… (12m 3s)', now: claimedAt + 95 * minute }),
				`**herdr-linear** (\`running\`): the run has been going for 95 min, over the 90 min cap. It keeps running.

Last lines of the pane:

\`\`\`
✻ Running tests… (12m 3s)
\`\`\`

Look at the agent in its tab. Or: ${startOver}`,
				'<!-- herdr-linear:UNB-12:overCap:1791000000000 -->',
			),
		),
	);

	it.effect('flags a start failure, with the pane tail when there is one', () =>
		withComments((comments) => {
			assertComment(
				comments.startFailed({
					identifier: 'UNB-12',
					claimedAt,
					error: 'Claude did not start in w2:t3: no agent is running',
					tail: Option.some('zsh: command not found: claude'),
				}),
				`**herdr-linear** (\`error\`): couldn't start an agent for this epic: Claude did not start in w2:t3: no agent is running

Last lines of the pane:

\`\`\`
zsh: command not found: claude
\`\`\`

Fix the problem, then remove the \`agent-stuck\` label to retry.`,
				'<!-- herdr-linear:UNB-12:startFailed:1791000000000 -->',
			);
			assertComment(
				comments.startFailed({ identifier: 'UNB-12', claimedAt, error: 'the agent was not confirmed running within 300 s', tail: Option.none() }),
				`**herdr-linear** (\`error\`): couldn't start an agent for this epic: the agent was not confirmed running within 300 s

Fix the problem, then remove the \`agent-stuck\` label to retry.`,
				'<!-- herdr-linear:UNB-12:startFailed:1791000000000 -->',
			);
		}),
	);

	it.effect('flags an invalid result file', () =>
		withComments((comments) =>
			assertComment(
				comments.invalidResult({ identifier: 'UNB-12', claimedAt, error: 'not JSON: Unexpected token } in JSON at position 41' }),
				`**herdr-linear** (\`error\`): the agent's result file is invalid:

\`\`\`
not JSON: Unexpected token } in JSON at position 41
\`\`\`

${startOver}`,
				'<!-- herdr-linear:UNB-12:invalidResult:1791000000000 -->',
			),
		),
	);

	it.effect('flags a result file without a PR', () =>
		withComments((comments) =>
			assertComment(
				comments.noPullRequest({ identifier: 'UNB-12', claimedAt, branch: 'mario/unb-12-plugin-settings-sync' }),
				`**herdr-linear** (\`error\`): the agent wrote its result file, but branch \`mario/unb-12-plugin-settings-sync\` has no open or merged PR. ${startOver}`,
				'<!-- herdr-linear:UNB-12:noPullRequest:1791000000000 -->',
			),
		),
	);

	it.effect('flags replies that do not match the dispatched threads', () =>
		withComments((comments) => {
			const mismatch = replyMismatch(
				['PRRT_inline', 'PRRT_accepted_flag'],
				[
					{ threadId: 'PRRT_inline', body: 'Renamed it.' },
					{ threadId: 'PRRT_inline', body: 'Also derived the type.' },
					{ threadId: 'PRRT_other', body: 'Done.' },
				],
			);

			assert.deepStrictEqual(
				mismatch,
				Option.some('no reply for PRRT_accepted_flag; replies to threads it was not given PRRT_other; more than one reply for PRRT_inline'),
			);
			assertComment(
				comments.threadMismatch({
					identifier: 'UNB-12',
					claimedAt,
					job: { _tag: 'follow-up', threadIds: ['PRRT_inline', 'PRRT_accepted_flag'], instruction: null },
					mismatch: 'no reply for PRRT_accepted_flag',
				}),
				`**herdr-linear** (\`error\`): the agent's result file does not match the review threads it was given: no reply for PRRT_accepted_flag. Nothing was posted to the PR. Remove the label, move the epic to To Review and mention @orchestratorbot to ask for the follow-up again.`,
				'<!-- herdr-linear:UNB-12:threadMismatch:1791000000000 -->',
			);
			assertComment(
				comments.threadMismatch({ identifier: 'UNB-12', claimedAt, job: { _tag: 'orchestrate' }, mismatch: 'replies to threads it was not given PRRT_other' }),
				`**herdr-linear** (\`error\`): the agent's result file does not match the review threads it was given: replies to threads it was not given PRRT_other. Nothing was posted to the PR. ${startOver}`,
				'<!-- herdr-linear:UNB-12:threadMismatch:1791000000000 -->',
			);
			assert.deepStrictEqual(replyMismatch(['PRRT_inline'], [{ threadId: 'PRRT_inline', body: 'Renamed it.' }]), Option.none());
		}),
	);

	it.effect('tells the user a reply could not be typed into the pane', () =>
		withComments((comments) =>
			assertComment(
				comments.replyFailed({ identifier: 'UNB-12', replyCommentId: 'comment-7', error: 'herdr agent_blocked: agent is waiting on a dialog' }),
				"**herdr-linear:** couldn't type your last reply into the agent's pane: herdr agent_blocked: agent is waiting on a dialog. Answer the agent in its tab.",
				'<!-- herdr-linear:UNB-12:replyFailed:comment-7 -->',
			),
		),
	);

	it.effect('says where a kept worktree is, for a run and for an orphan', () =>
		withComments((comments) => {
			const text =
				'**herdr-linear:** kept the worktree `/home/dev/.herdr/worktrees/unbound/mario-unb-12-plugin-settings-sync` because it has 2 unpushed commits. Push or discard that work and it is removed on a later poll.';

			assertComment(
				comments.keptWorktree({ identifier: 'UNB-12', claimedAt: Option.some(claimedAt), worktreePath: run.worktreePath, reason: '2 unpushed commits' }),
				text,
				'<!-- herdr-linear:UNB-12:keptWorktree:1791000000000 -->',
			);
			assertComment(
				comments.keptWorktree({ identifier: 'UNB-12', claimedAt: Option.none(), worktreePath: run.worktreePath, reason: '2 unpushed commits' }),
				text,
				'<!-- herdr-linear:UNB-12:keptWorktree:%2Fhome%2Fdev%2F.herdr%2Fworktrees%2Funbound%2Fmario-unb-12-plugin-settings-sync -->',
			);
		}),
	);

	it.effect('flags a transient failure streak, a permanent failure and a working orphan tab', () =>
		withComments((comments) => {
			assertComment(
				comments.transientFailure({ identifier: 'UNB-12', streakStartedAt: claimedAt, error: 'Linear answered HTTP 503: service unavailable', now: claimedAt + 11 * minute }),
				'**herdr-linear** (`error`): calls for this epic have been failing for 11 min: Linear answered HTTP 503: service unavailable. It keeps retrying on every poll; this comment is not repeated.',
				'<!-- herdr-linear:UNB-12:transientFailure:1791000000000 -->',
			);
			assertComment(
				comments.permanentFailure({ identifier: 'UNB-12', claimedAt, error: "git -C /home/dev/unbound fetch origin: fatal: 'origin' does not appear to be a git repository" }),
				"**herdr-linear** (`error`): a call for this epic failed and retrying cannot help: git -C /home/dev/unbound fetch origin: fatal: 'origin' does not appear to be a git repository\n\nFix the problem, then remove the `agent-stuck` label to retry.",
				'<!-- herdr-linear:UNB-12:permanentFailure:1791000000000 -->',
			);
			assertComment(
				comments.workingOrphan({ identifier: 'UNB-12', tabLabel: 'UNB-12 Plugin settings sync', tabId: 'w2:t3', paneId: 'w2:p5' }),
				'**herdr-linear:** the agent in tab `UNB-12 Plugin settings sync` (w2:t3), pane w2:p5, is working, but no run of this epic tracks it. It is left running, and its tab is closed once the agent stops working.',
				'<!-- herdr-linear:UNB-12:workingOrphan:w2%3At3 -->',
			);
		}),
	);

	it.effect('writes the PR summary with the author mention, the flags review body and thread replies', () =>
		withComments((comments) => {
			assertComment(
				comments.summary({ identifier: 'UNB-12', claimedAt, summary: 'Added settings sync.\n\n1. Synced plugin settings.', authorLogin: 'marioparaschiv' }),
				'Added settings sync.\n\n1. Synced plugin settings.\n\nReady for review, @marioparaschiv.',
				'<!-- herdr-linear:UNB-12:summary:1791000000000 -->',
			);
			assertComment(comments.flagsReview({ identifier: 'UNB-12', claimedAt }), 'Self-review findings I did not fix in this PR.', '<!-- herdr-linear:UNB-12:flags:1791000000000 -->');
			assertComment(
				comments.threadReply({ identifier: 'UNB-12', claimedAt, threadId: 'PRRT_kwDOMx1c5s5Qj2', body: 'Renamed the sync function and derived the settings type.' }),
				'Renamed the sync function and derived the settings type.',
				'<!-- herdr-linear:UNB-12:reply:PRRT_kwDOMx1c5s5Qj2.1791000000000 -->',
			);
		}),
	);

	it.effect("writes a command's replies and its failure, keyed by the request and the claim", () =>
		withComments((comments) => {
			assertComment(comments.commandReply({ identifier: 'CMD-3', requestId: 7, body: 'Stopped UNB-12 and closed its tab.' }), 'Stopped UNB-12 and closed its tab.', '<!-- herdr-linear:CMD-3:commandReply:7 -->');
			assertComment(
				comments.commandFailed({ identifier: 'CMD-3', claimedAt, reason: 'exited', tail: Option.some('⏺ Checking the PR.') }),
				["**herdr-linear** (`error`): CMD-3 exited, so I stopped it.", '', 'Last lines of the pane:', '', '```\n⏺ Checking the PR.\n```', '', 'Mention @orchestratorbot again to retry.'].join('\n'),
				'<!-- herdr-linear:CMD-3:commandFailed:1791000000000 -->',
			);
		}),
	);
});
