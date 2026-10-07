import { assert, describe, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { Comments, replyMismatch } from './comments.ts';
import { AppConfig } from './config.ts';
import { type MarkedComment, type Marker, type Notice, parseMarker } from './markers.ts';

const minute = 60_000;
const claimedAt = 1_791_000_000_000;

const worktreePath = '/home/dev/.t3/worktrees/unbound/mario-unb-12-plugin-settings-sync';

const startOver = 'Remove the `agent-stuck` label and move the epic back to Ready For Agent to start over.';

const retryAfterFix = 'Fix the problem, then remove the `agent-stuck` label to retry.';

const withComments = <A>(use: (comments: Comments['Service']) => A) =>
	Comments.useSync(use).pipe(Effect.provide(Comments.layer), Effect.provide(AppConfig.layerTest('/tmp/sapphire-agent-test')));

const assertComment = (comment: MarkedComment, text: string, marker: string) => {
	assert.strictEqual(comment.body, `${text}\n\n${marker}`);
	assert.deepStrictEqual(parseMarker(comment.body), Option.some(comment.marker));
};

const assertNotice = (notice: Notice, text: string, marker: Marker) => {
	assert.strictEqual(notice.text, text);
	assert.deepStrictEqual(notice.marker, marker);
};

describe('Comments', () => {
	it.effect('flags a T3 run that shows no progress after the nudge', () =>
		withComments((comments) =>
			assertNotice(
				comments.threadStale({
					identifier: 'UNB-12',
					claimedAt,
					threadTitle: 'UNB-12 Plugin settings sync',
					threadId: '0d3b6f2a-8c41-4e7d-9a5b-1f2e3d4c5b6a',
					worktreePath,
					branch: 'mario/unb-12-plugin-settings-sync',
					agentStatusSince: claimedAt + 10 * minute,
					now: claimedAt + 30 * minute,
					nudgedAt: claimedAt + 20 * minute,
				}),
				`🔴 **UNB-12 looks stuck**: its T3 thread shows no progress for 20 min, even after a nudge, and no result file.
- T3 thread: \`UNB-12 Plugin settings sync\` (0d3b6f2a-8c41-4e7d-9a5b-1f2e3d4c5b6a)
- Worktree: \`${worktreePath}\` on \`mario/unb-12-plugin-settings-sync\`
- Label: \`agent-stuck\`
Next: Look at the agent in its T3 thread.`,
				{ identifier: 'UNB-12', purpose: 'stale', key: '1791000000000-1791001200000' },
			),
		),
	);

	it.effect('flags a run over the wall-clock cap', () =>
		withComments((comments) =>
			assertNotice(
				comments.overCap({ identifier: 'UNB-12', claimedAt, status: 'running', now: claimedAt + 95 * minute }),
				'⏰ **UNB-12 is over the time cap**: 95 min, cap 90 min. It keeps running.\n- Status: `running`\nNext: Look at the agent in its T3 thread.',
				{ identifier: 'UNB-12', purpose: 'overCap', key: '1791000000000' },
			),
		),
	);

	it.effect('flags a start failure', () =>
		withComments((comments) =>
			assertNotice(
				comments.startFailed({ identifier: 'UNB-12', claimedAt, error: 'T3 refused t3_thread_launch: project not found (project_not_found)' }),
				`🔴 **UNB-12 didn't start**: T3 refused t3_thread_launch: project not found (project_not_found)\nNext: ${retryAfterFix}`,
				{ identifier: 'UNB-12', purpose: 'startFailed', key: '1791000000000' },
			),
		),
	);

	it.effect('flags an invalid result file and one without a PR', () =>
		withComments((comments) => {
			assertNotice(
				comments.invalidResult({ identifier: 'UNB-12', claimedAt, error: 'not JSON: Unexpected token } in JSON at position 41' }),
				`🔴 **UNB-12 wrote an invalid result file**\n\`\`\`\nnot JSON: Unexpected token } in JSON at position 41\n\`\`\`\nNext: ${startOver}`,
				{ identifier: 'UNB-12', purpose: 'invalidResult', key: '1791000000000' },
			);
			assertNotice(
				comments.noPullRequest({ identifier: 'UNB-12', claimedAt, branch: 'mario/unb-12-plugin-settings-sync' }),
				`🔴 **UNB-12 has no PR**: the agent wrote its result file, but \`mario/unb-12-plugin-settings-sync\` has no open or merged PR.\nNext: ${startOver}`,
				{ identifier: 'UNB-12', purpose: 'noPullRequest', key: '1791000000000' },
			);
		}),
	);

	it.effect('shows only the last 10 lines of an error', () =>
		withComments((comments) => {
			const error = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
			const { text } = comments.invalidResult({ identifier: 'UNB-12', claimedAt, error });

			assert.include(text, `\`\`\`\n${Array.from({ length: 10 }, (_, index) => `line ${index + 31}`).join('\n')}\n\`\`\``);
			assert.notInclude(text, 'line 30\n');
		}),
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
			assertNotice(
				comments.threadMismatch({
					identifier: 'UNB-12',
					claimedAt,
					job: { _tag: 'follow-up', threadIds: ['PRRT_inline', 'PRRT_accepted_flag'], instruction: null },
					mismatch: 'no reply for PRRT_accepted_flag',
				}),
				"🔴 **UNB-12's replies don't match its review threads**: no reply for PRRT_accepted_flag. Nothing was posted to the PR.\nNext: Remove the `agent-stuck` label, move the epic to To Review and ask for the follow-up again.",
				{ identifier: 'UNB-12', purpose: 'threadMismatch', key: '1791000000000' },
			);
			assert.strictEqual(
				comments.threadMismatch({ identifier: 'UNB-12', claimedAt, job: { _tag: 'orchestrate' }, mismatch: 'replies to threads it was not given PRRT_other' }).text,
				`🔴 **UNB-12's replies don't match its review threads**: replies to threads it was not given PRRT_other. Nothing was posted to the PR.\nNext: ${startOver}`,
			);
			assert.deepStrictEqual(replyMismatch(['PRRT_inline'], [{ threadId: 'PRRT_inline', body: 'Renamed it.' }]), Option.none());
		}),
	);

	it.effect('says where a kept worktree is, for a run and for an orphan', () =>
		withComments((comments) => {
			const text =
				"📦 **Kept UNB-12's worktree**: it has 2 unpushed commits.\n- Worktree: `/home/dev/.t3/worktrees/unbound/mario-unb-12-plugin-settings-sync`\nNext: Push or discard that work; the worktree is removed on a later poll.";

			assertNotice(
				comments.keptWorktree({ identifier: 'UNB-12', claimedAt: Option.some(claimedAt), worktreePath, reason: '2 unpushed commits' }),
				text,
				{ identifier: 'UNB-12', purpose: 'keptWorktree', key: '1791000000000' },
			);
			assertNotice(comments.keptWorktree({ identifier: 'UNB-12', claimedAt: Option.none(), worktreePath, reason: '2 unpushed commits' }), text, {
				identifier: 'UNB-12',
				purpose: 'keptWorktree',
				key: worktreePath,
			});
		}),
	);

	it.effect('flags a transient failure streak and a permanent failure', () =>
		withComments((comments) => {
			assertNotice(
				comments.transientFailure({ identifier: 'UNB-12', streakStartedAt: claimedAt, error: 'Linear answered HTTP 503: service unavailable', now: claimedAt + 11 * minute }),
				"⚠️ **UNB-12's calls keep failing** for 11 min: Linear answered HTTP 503: service unavailable\nNext: Nothing unless it lasts; it retries on every poll.",
				{ identifier: 'UNB-12', purpose: 'transientFailure', key: '1791000000000' },
			);
			assertNotice(
				comments.permanentFailure({ identifier: 'UNB-12', claimedAt, error: "git -C /home/dev/unbound fetch origin: fatal: 'origin' does not appear to be a git repository" }),
				`🔴 **A call for UNB-12 failed for good**: git -C /home/dev/unbound fetch origin: fatal: 'origin' does not appear to be a git repository\nNext: ${retryAfterFix}`,
				{ identifier: 'UNB-12', purpose: 'permanentFailure', key: '1791000000000' },
			);
		}),
	);

	it.effect('sums up a finished run and lists at most 5 of its flags', () =>
		withComments((comments) => {
			const url = 'https://github.com/marioparaschiv/unbound/pull/120';

			assertNotice(
				comments.summary({ identifier: 'UNB-12', claimedAt, summary: 'Added settings sync.\n\n1. Synced plugin settings.', url }),
				`✅ **UNB-12 is ready for review**: ${url}\nAdded settings sync.\n\n1. Synced plugin settings.\nNext: Review the PR.`,
				{ identifier: 'UNB-12', purpose: 'summary', key: '1791000000000' },
			);
			assertNotice(
				comments.flags({
					identifier: 'UNB-12',
					claimedAt,
					flags: Array.from({ length: 7 }, (_, index) => ({ path: 'src/sync.ts', line: index + 1, body: `Finding ${index + 1}\nwith detail.` })),
				}),
				[
					'🔎 **UNB-12 left 7 self-review findings unfixed**',
					'- `src/sync.ts:1` Finding 1 with detail.',
					'- `src/sync.ts:2` Finding 2 with detail.',
					'- `src/sync.ts:3` Finding 3 with detail.',
					'- `src/sync.ts:4` Finding 4 with detail.',
					'- …and 3 more',
					'Next: Ask for a follow-up to fix any of them.',
				].join('\n'),
				{ identifier: 'UNB-12', purpose: 'flags', key: '1791000000000' },
			);
		}),
	);

	it.effect('writes the only Linear and PR comments: the PR link, thread replies and one line after them', () =>
		withComments((comments) => {
			assertComment(
				comments.pullRequestOpened({ identifier: 'UNB-12', url: 'https://github.com/marioparaschiv/unbound/pull/120' }),
				'PR opened: https://github.com/marioparaschiv/unbound/pull/120',
				'<!-- sapphire-agent:UNB-12:pullRequestOpened:https%3A%2F%2Fgithub.com%2Fmarioparaschiv%2Funbound%2Fpull%2F120 -->',
			);
			assertComment(
				comments.threadReply({ identifier: 'UNB-12', claimedAt, threadId: 'PRRT_kwDOMx1c5s5Qj2', body: 'Renamed the sync function and derived the settings type.' }),
				'Renamed the sync function and derived the settings type.',
				'<!-- sapphire-agent:UNB-12:reply:PRRT_kwDOMx1c5s5Qj2.1791000000000 -->',
			);
			assertComment(comments.addressed({ identifier: 'UNB-12', claimedAt }), 'Addressed your concerns inline.', '<!-- sapphire-agent:UNB-12:addressed:1791000000000 -->');
		}),
	);

	it.effect("writes a command's replies and its failure, keyed by the request and the claim", () =>
		withComments((comments) => {
			assertComment(comments.commandReply({ identifier: 'CMD-3', requestId: 7, body: 'Stopped UNB-12.' }), 'Stopped UNB-12.', '<!-- sapphire-agent:CMD-3:commandReply:7 -->');
			assertComment(
				comments.commandFailed({ identifier: 'CMD-3', claimedAt, reason: 'lost its T3 thread' }),
				["**sapphire-agent** (`error`): CMD-3 lost its T3 thread, so I stopped it.", '', 'Mention @orchestratorbot again to retry.'].join('\n'),
				'<!-- sapphire-agent:CMD-3:commandFailed:1791000000000 -->',
			);
		}),
	);
});
