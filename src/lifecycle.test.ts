import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Option, Random } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import type { WebhookDelivery } from './github-app-fixture.ts';
import type { Command, Run } from './journal.ts';
import { parseMarker } from './markers.ts';
import { deliveredEmoji } from './monitoring.ts';
import { deliveries, git, type Harness, makeHarness } from './test-harness.ts';

const writeKinds = ['journal', 'linear', 'github', 'herdr', 'telegram'] as const;

type CrashPoint = { readonly kind: (typeof writeKinds)[number]; readonly nth: number };

const describePoint = ({ kind, nth }: CrashPoint) => `crash at ${kind} write ${nth}`;

const processDied = new Transient({ message: 'the process died' });

// Every write counter starts at zero in a fresh harness, so arming before the first tick counts from the start.
const arm = (h: Harness, { kind, nth }: CrashPoint) => {
	switch (kind) {
		case 'journal':
			return h.crashAtJournalWrite(nth);
		case 'linear':
			return h.linear.crashAfterWrite(nth);
		case 'github':
			return h.github.crashAfterWrite(nth, processDied);
		case 'herdr':
			return h.herdr.crashAfterWrite(nth, processDied);
		case 'telegram':
			return h.telegram.crashAfterWrite(nth, processDied);
	}
};

const writesSoFar = (h: Harness): Record<CrashPoint['kind'], number> => ({
	journal: h.journalWrites(),
	// No Linear write fails in this test, so every write request is applied.
	linear: h.linear.mutations.length,
	github: h.github.writes(),
	herdr: h.herdr.writes(),
	telegram: h.telegram.writes(),
});

// The crash points run in a shuffled but fixed order.
const seed = 20_261_004;

const question = '⏺ The sync needs a conflict rule.\n\n❯ Which should win, local or remote?';

const markerOrFirstLine = (body: string) =>
	Option.match(parseMarker(body), { onNone: () => body.split('\n')[0], onSome: (marker) => `${marker.purpose}:${marker.key}` });

// Ticks the reconciler as the service would. The armed crash kills the process: a Linear write is applied and the
// tick is interrupted while it waits to retry; a journal, GitHub or herdr crash fails that epic's work. Either way a
// fresh reconciler takes over on the same journal before the next tick.
const makeDriver = (h: Harness, crash: Option.Option<CrashPoint>) => {
	let pending = crash;
	let retypes = false;

	if (Option.isSome(pending)) {
		arm(h, pending.value);
	}

	const tick = Effect.gen(function* () {
		const typedBefore = h.herdr.prompts().length;
		const fiber = yield* Effect.forkChild(h.tick);

		if (Option.exists(pending, (point) => point.kind === 'linear')) {
			yield* Effect.raceFirst(Fiber.join(fiber), h.linear.awaitCrash);
		} else {
			yield* Fiber.join(fiber);
		}

		if (Option.exists(pending, (point) => writesSoFar(h)[point.kind] >= point.nth)) {
			yield* Fiber.interrupt(fiber);

			// A reply is typed before it is recorded, so a crash in between types it again after the restart.
			const typed = h.herdr.prompts().length - typedBefore;
			const recorded = (yield* h.runs).flatMap((run) => run.deliveredReplyIds).length;

			retypes = typed > 0 && recorded === 0;
			pending = Option.none();
			yield* h.restart;
		}
	});

	// Ticks until the reconciler got there. The bound only turns a hang into a failure.
	const tickUntil = (what: string, reached: (runs: ReadonlyArray<Run>, commands: ReadonlyArray<Command>) => boolean) =>
		Effect.gen(function* () {
			for (let ticks = 0; ticks < 5; ticks += 1) {
				yield* tick;

				if (reached(yield* h.runs, yield* h.commands)) {
					return;
				}
			}

			assert.fail(`${what} was not reached${Option.match(crash, { onNone: () => '', onSome: (point) => ` after a ${describePoint(point)}` })}`);
		});

	// A delivery the crash failed is redelivered once the service is back, as GitHub's delivery log allows.
	const deliver = (delivery: WebhookDelivery) =>
		Effect.gen(function* () {
			if ((yield* h.deliver(delivery)) === 204) {
				return;
			}

			assert.isTrue(Option.exists(pending, (point) => writesSoFar(h)[point.kind] >= point.nth), 'a delivery failed without a crash');
			pending = Option.none();
			yield* h.restart;
			assert.strictEqual(yield* h.deliver(delivery), 204);
		});

	return { tickUntil, deliver, crashed: () => Option.isSome(crash) && Option.isNone(pending), retypes: () => retypes };
};

const runOf = (runs: ReadonlyArray<Run>) => Option.fromUndefinedOr(runs[0]);

const isRun = (runs: ReadonlyArray<Run>, predicate: (run: Run) => boolean) => Option.exists(runOf(runs), predicate);

const ownTabs = (h: Harness) => h.herdr.tabs().filter((tab) => tab.label.startsWith('TEST-10 '));

const ownTab = (h: Harness) => {
	const [tab] = ownTabs(h);

	if (!tab) {
		throw new Error('TEST-10 has no tab');
	}

	return tab;
};

const commandTab = (h: Harness) => {
	const tab = h.herdr.tabs().find((candidate) => candidate.label === '@bot CMD-1');

	if (!tab) {
		throw new Error('CMD-1 has no tab');
	}

	return tab;
};

const currentRun = (h: Harness) =>
	h.runs.pipe(
		Effect.map((runs) => {
			const [run] = runs;

			if (!run?.worktreePath) {
				throw new Error('TEST-10 has no started run');
			}

			return { ...run, worktreePath: run.worktreePath };
		}),
	);

// The whole life of one epic: dispatch, a question relayed through Linear, the result posted to the PR, a review thread
// that mentions the bot, whose command hands it to a follow-up, the cleanup once the PR is merged, and its chat topic,
// summed up once it ships. Returns everything the run left behind in Linear, GitHub, herdr, git, Telegram and the
// journal.
const lifecycle = (crash: Option.Option<CrashPoint>) =>
	Effect.gen(function* () {
		const h = yield* makeHarness();
		const { tickUntil, deliver, crashed, retypes } = makeDriver(h, crash);

		// The workspace exists already, as in production, and the user has written to the bot, so it may write to them.
		h.herdr.addTab({ label: 'notes', workspace: 'Test', agent: null });
		h.telegram.write({ from: h.telegramUser, text: 'hi' });

		// Dispatch: Ready For Agent becomes a tab running Claude, and the epic moves to Implementing.
		const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

		yield* tickUntil('the start', (runs) => isRun(runs, (run) => run.status === 'running'));

		const { paneId } = ownTab(h);
		const { worktreePath, branch } = yield* currentRun(h);

		assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');

		// Monitoring: the agent stops to ask, the question goes to the epic, the user's reply is typed into the pane.
		h.herdr.setAgentStatus(paneId, 'idle');
		h.herdr.setTail(paneId, question);
		yield* tickUntil('the quiet agent', (runs) => isRun(runs, (run) => run.agentStatus === 'idle'));
		yield* TestClock.adjust('3 minutes');
		yield* tickUntil('the question', (runs) => isRun(runs, (run) => run.status === 'awaitingInput'));

		const questionId = Option.getOrThrow(Option.flatMap(runOf(yield* h.runs), (run) => Option.fromNullishOr(run.questionCommentId)));
		const reply = h.linear.addComment(epic.id, 'Remote wins.\nKeep a backup of local.', { parentId: questionId });

		yield* tickUntil('the delivered reply', () => h.linear.comments(epic.id).some((comment) => comment.id === reply.id && comment.reactions.includes(deliveredEmoji)));
		h.herdr.setAgentStatus(paneId, 'working');
		h.herdr.setTail(paneId, '⏺ Wrote src/sync/merge.ts');
		yield* tickUntil('the working agent', (runs) => isRun(runs, (run) => run.status === 'running' && run.questionCommentId === null));

		// Results: the agent pushed, opened the PR and wrote its result file.
		git(worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
		git(worktreePath, 'push', '--quiet', 'origin', branch);

		const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });

		h.herdr.setAgentStatus(paneId, 'done');
		h.writeResultFile(
			yield* currentRun(h),
			JSON.stringify({ summary: 'Plugin settings now sync across devices.', replies: [], flags: [{ path: 'src/sync/merge.ts', line: 3, body: 'Remote wins without a merge.' }] }),
		);
		yield* tickUntil('the posted result', (runs) => isRun(runs, (run) => run.status === 'ended'));
		assert.deepStrictEqual([h.linear.stateName(epic.id), ownTabs(h)], ['To Review', []]);

		// Command: a minute later the reviewer asks the bot for a change in a review thread, and GitHub delivers it to the
		// webhook. Its agent replies, hands the thread to a follow-up and says it is done.
		yield* TestClock.adjust('1 minute');

		const threadId = h.github.addThread(h.githubRepo, pullRequest.number, { comments: [{ body: 'Rename this to syncSettings. @orchestratorbot' }] });
		const [mention] = h.github.thread(threadId).comments;

		yield* deliver(deliveries.reviewComment(h.githubRepo, pullRequest.number, mention));
		yield* tickUntil('the command start', (_, commands) => commands.some((command) => command.status === 'running'));
		yield* h.ctl('reply', mention.url, 'On it: a follow-up renames it.');
		yield* h.ctl('follow-up', 'TEST-10', '--threads', threadId);
		yield* h.ctl('done', 'CMD-1');
		h.herdr.setAgentStatus(commandTab(h).paneId, 'done');

		// Follow-up: it answers and resolves the thread.
		yield* tickUntil('the follow-up start', (runs) => isRun(runs, (run) => run.job._tag === 'follow-up' && run.status === 'running'));
		git(worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Rename to syncSettings');
		git(worktreePath, 'push', '--quiet', 'origin', branch);
		h.herdr.setAgentStatus(ownTab(h).paneId, 'done');
		h.writeResultFile(
			yield* currentRun(h),
			JSON.stringify({ summary: 'Renamed the sync function.', replies: [{ threadId, body: 'Renamed it to syncSettings.' }], flags: [] }),
		);
		yield* tickUntil('the posted follow-up', (runs, commands) => isRun(runs, (run) => run.job._tag === 'follow-up' && run.status === 'ended') && commands.every((command) => command.status === 'ended'));
		assert.deepStrictEqual([h.linear.stateName(epic.id), ownTabs(h)], ['To Review', []]);

		// Cleanup: the PR is merged.
		h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
		yield* tickUntil('the cleanup', (runs) => runs.length === 0);

		// Shipped: the epic's topic is summed up in the Done topic and goes.
		h.moveEpic(epic.id, 'Shipped');
		yield* tickUntil('the shipped topic', () => h.telegram.sent.some((message) => message.text.endsWith(' slices')) && !h.telegram.topics().some((topic) => topic.title.startsWith('👀 TEST-10')));

		const comments = h.linear.comments(epic.id);
		const thread = h.github.thread(threadId);

		return {
			crashed: crashed(),
			retypes: retypes(),
			writes: writesSoFar(h),
			outcome: {
				linear: {
					state: h.linear.stateName(epic.id),
					labels: h.linear.labelNames(epic.id),
					comments: comments.map((comment) => [
						markerOrFirstLine(comment.body),
						Option.getOrNull(Option.map(Option.fromUndefinedOr(comments.find((parent) => parent.id === comment.parentId)), (parent) => markerOrFirstLine(parent.body))),
						comment.reactions,
					]),
				},
				github: {
					comments: h.github.comments(h.githubRepo, pullRequest.number).map(markerOrFirstLine),
					reviews: h.github.reviews(h.githubRepo, pullRequest.number).map((review) => [markerOrFirstLine(review.body), review.comments.map((comment) => `${comment.path}:${comment.line}`)]),
					thread: [thread.isResolved, thread.comments.map((comment) => markerOrFirstLine(comment.body))],
				},
				herdr: {
					ownedTabs: ownTabs(h).length,
					openTabs: h.herdr.tabs().filter((tab) => tab.label !== 'notes').length,
					starts: h.herdr.starts().map((start) => start.prompt.split(' ')[0]),
					prompts: h.herdr.prompts().map((prompt) => prompt.text),
				},
				telegram: { topics: h.telegram.topics().map((topic) => topic.title).toSorted(), sent: h.telegram.sent.map((message) => message.text) },
				commands: (yield* h.commands).map((command) => `${command.status} ${command.author}`),
				git: { worktrees: h.worktrees(), branch: h.hasBranch(branch) },
				runs: (yield* h.runs).length,
			},
		};
	}).pipe(
		Effect.scoped,
		// Each lifecycle starts at time 0, so markers keyed by time match across runs.
		Effect.provide(TestClock.layer()),
	);

describe('lifecycle', () => {
	it.effect(
		'one epic from Ready For Agent to Shipped ends the same, with nothing posted twice, after a crash at any write',
		() =>
			Effect.gen(function* () {
				const uncrashed = yield* lifecycle(Option.none());
				const followUpAt = 4 * 60_000;
				const pullRequestUrl = 'https://github.com/test/repo/pull/1';

				assert.deepStrictEqual(uncrashed.outcome, {
					linear: {
						state: 'Shipped',
						labels: [],
						comments: [
							['awaitingInput:0-0', null, []],
							['Remote wins.', 'awaitingInput:0-0', [deliveredEmoji]],
						],
					},
					github: {
						comments: ['summary:0', 'commandReply:1', `summary:${followUpAt}`],
						reviews: [['flags:0', ['src/sync/merge.ts:3']]],
						thread: [true, ['Rename this to syncSettings. @orchestratorbot', `reply:PRRT_1.${followUpAt}`]],
					},
					herdr: { ownedTabs: 0, openTabs: 0, starts: ['/orchestrate', 'You', '/follow-up'], prompts: ['Remote wins. Keep a backup of local.'] },
					commands: ['ended marioparaschiv'],
					git: { worktrees: [], branch: false },
					runs: 0,
					telegram: {
						topics: ['✅ Done'],
						sent: [`PR opened: ${pullRequestUrl}`, `TEST-10 Plugin settings sync: PR opened ${pullRequestUrl}`, `TEST-10 Plugin settings sync · ${pullRequestUrl} · 2 slices`],
					},
				});

				const points = writeKinds.flatMap((kind) => Array.from({ length: uncrashed.writes[kind] }, (_, index): CrashPoint => ({ kind, nth: index + 1 })));
				const { prompts } = uncrashed.outcome.herdr;
				const retyped: Array<CrashPoint['kind']> = [];
				const strayTopics: Array<string> = [];

				for (const point of yield* Random.shuffle(points).pipe(Random.withSeed(seed))) {
					const { crashed, retypes, outcome } = yield* lifecycle(Option.some(point));
					const strays = outcome.telegram.topics.filter((title, index) => outcome.telegram.topics.indexOf(title) !== index || !uncrashed.outcome.telegram.topics.includes(title));
					const expected = retypes ? { ...uncrashed.outcome, herdr: { ...uncrashed.outcome.herdr, prompts: [...prompts, ...prompts] } } : uncrashed.outcome;

					assert.isTrue(crashed, `${describePoint(point)} never happened`);
					assert.deepStrictEqual(outcome, strays.length === 0 ? expected : { ...expected, telegram: { ...expected.telegram, topics: [...expected.telegram.topics, ...strays].toSorted() } }, describePoint(point));

					if (retypes) {
						retyped.push(point.kind);
					}

					strayTopics.push(...strays.map((title) => `${point.kind} ${title}`));
				}

				// Typing the reply into the pane and recording it in the journal cannot be one step: a crash after the herdr
				// prompt, or at the journal write that records it, types it again.
				assert.deepStrictEqual(retyped.toSorted(), ['herdr', 'journal']);
				// Nor can making a topic and recording it (Telegram does not let a bot list topics): a crash right after making
				// the epic's or the Done topic, or at the journal write that records it, leaves that topic behind and makes
				// another.
				assert.deepStrictEqual(strayTopics.toSorted(), ['journal ✅ Done', 'journal 🟢 TEST-10 Plugin settings sync', 'telegram ✅ Done', 'telegram 🟢 TEST-10 Plugin settings sync']);
			}),
		{ timeout: 120_000 },
	);
});
