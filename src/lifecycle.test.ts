import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Option, Random } from 'effect';
import { TestClock } from 'effect/testing';
import { Transient } from './call-policy.ts';
import type { WebhookDelivery } from './github-app-fixture.ts';
import type { Command, Run } from './journal.ts';
import { parseMarker } from './markers.ts';
import { deliveries, git, type Harness, makeHarness } from './test-harness.ts';

const writeKinds = ['journal', 'linear', 'github'] as const;

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
	}
};

const writesSoFar = (h: Harness): Record<CrashPoint['kind'], number> => ({
	journal: h.journalWrites(),
	// No Linear write fails in this test, so every write request is applied.
	linear: h.linear.mutations.length,
	github: h.github.writes(),
});

// The crash points run in a shuffled but fixed order.
const seed = 20_261_004;

const markerOrFirstLine = (body: string) =>
	Option.match(parseMarker(body), { onNone: () => body.split('\n')[0], onSome: (marker) => `${marker.purpose}:${marker.key}` });

// Ticks the reconciler as the service would. The armed crash kills the process: a Linear write is applied and the
// tick is interrupted while it waits to retry; a journal or GitHub crash fails that epic's work. Either way a
// fresh reconciler takes over on the same journal before the next tick.
const makeDriver = (h: Harness, crash: Option.Option<CrashPoint>) => {
	let pending = crash;

	if (Option.isSome(pending)) {
		arm(h, pending.value);
	}

	const tick = Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(h.tick);

		if (Option.exists(pending, (point) => point.kind === 'linear')) {
			yield* Effect.raceFirst(Fiber.join(fiber), h.linear.awaitCrash);
		} else {
			yield* Fiber.join(fiber);
		}

		if (Option.exists(pending, (point) => writesSoFar(h)[point.kind] >= point.nth)) {
			yield* Fiber.interrupt(fiber);
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

	// The process died at the armed crash: a fresh one takes over.
	const restartAfterCrash = (what: string) =>
		Effect.gen(function* () {
			assert.isTrue(Option.exists(pending, (point) => writesSoFar(h)[point.kind] >= point.nth), `${what} without a crash`);
			pending = Option.none();
			yield* h.restart;
		});

	// A delivery the crash failed is redelivered once the service is back, as GitHub's delivery log allows.
	const deliver = (delivery: WebhookDelivery) =>
		Effect.gen(function* () {
			if ((yield* h.deliver(delivery)) === 204) {
				return;
			}

			yield* restartAfterCrash('a delivery failed');
			assert.strictEqual(yield* h.deliver(delivery), 204);
		});

	return { tickUntil, deliver, crashed: () => Option.isSome(crash) && Option.isNone(pending) };
};

const runOf = (runs: ReadonlyArray<Run>) => Option.fromUndefinedOr(runs[0]);

const isRun = (runs: ReadonlyArray<Run>, predicate: (run: Run) => boolean) => Option.exists(runOf(runs), predicate);

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

// The T3 thread of the epic's current run.
const currentThread = (h: Harness) =>
	currentRun(h).pipe(
		Effect.map((run) => {
			if (run.threadId === null) {
				throw new Error('TEST-10 has no thread');
			}

			return run.threadId;
		}),
	);

// The whole life of one epic: dispatch, a question that waits in the agent's thread and is answered there, the result
// posted to the PR and the epic, a review thread that mentions the bot, whose command hands it to a follow-up, and the
// cleanup once the PR is merged. Returns everything the run left behind in Linear, GitHub, T3, Pushover, git and the
// journal.
const lifecycle = (crash: Option.Option<CrashPoint>) =>
	Effect.gen(function* () {
		const h = yield* makeHarness();
		const { tickUntil, deliver, crashed } = makeDriver(h, crash);

		// Dispatch: Ready For Agent becomes a T3 thread, the epic moves to Implementing, and T3 makes the worktree.
		const epic = h.linear.addEpic({ identifier: 'TEST-10', title: 'Plugin settings sync' });

		yield* tickUntil('the start', (runs) => isRun(runs, (run) => run.status === 'running'));

		const [started] = yield* h.runs;

		if (started.threadId === null) {
			return assert.fail('TEST-10 started without a thread');
		}

		yield* h.t3.setWorktreePath(started.threadId, h.makeT3Worktree(started.branch));
		yield* tickUntil('the recorded worktree', (runs) => isRun(runs, (run) => run.worktreePath !== null));

		const { worktreePath, branch } = yield* currentRun(h);

		assert.strictEqual(h.linear.stateName(epic.id), 'Implementing');

		// Monitoring: the agent asks a question in its thread, which Pushover is told of once; the user answers it there.
		yield* h.t3.setRunStatus(started.threadId, 'running');
		yield* h.t3.setPendingRequests(started.threadId, 1);
		yield* tickUntil('the question', (runs) => isRun(runs, (run) => run.agentStatus === 'blocked'));
		yield* h.t3.setPendingRequests(started.threadId, 0);
		yield* h.t3.addActivity(started.threadId);
		yield* tickUntil('the working agent', (runs) => isRun(runs, (run) => run.agentStatus === 'working'));

		// Results: the agent pushed, opened the PR and wrote its result file.
		git(worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Sync plugin settings');
		git(worktreePath, 'push', '--quiet', 'origin', branch);

		const pullRequest = h.github.addPullRequest({ repo: h.githubRepo, branch, author: 'marioparaschiv' });

		yield* h.t3.setRunStatus(started.threadId, 'completed');
		h.writeResultFile(
			yield* currentRun(h),
			JSON.stringify({ summary: 'Plugin settings now sync across devices.', replies: [], flags: [{ path: 'src/sync/merge.ts', line: 3, body: 'Remote wins without a merge.' }] }),
		);
		yield* tickUntil('the posted result', (runs) => isRun(runs, (run) => run.status === 'ended'));
		assert.strictEqual(h.linear.stateName(epic.id), 'To Review');

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

		const [command] = yield* h.commands;

		if (command.threadId === null) {
			return assert.fail('CMD-1 runs without a thread');
		}

		yield* h.t3.setRunStatus(command.threadId, 'completed');

		// Follow-up: it answers and resolves the thread.
		yield* tickUntil('the follow-up start', (runs) => isRun(runs, (run) => run.job._tag === 'follow-up' && run.status === 'running' && run.worktreePath !== null));
		git(worktreePath, 'commit', '--quiet', '--allow-empty', '-m', 'Rename to syncSettings');
		git(worktreePath, 'push', '--quiet', 'origin', branch);

		const followUpThread = yield* currentThread(h);

		yield* h.t3.setRunStatus(followUpThread, 'completed');
		h.writeResultFile(
			yield* currentRun(h),
			JSON.stringify({ summary: 'Renamed the sync function.', replies: [{ threadId, body: 'Renamed it to syncSettings.' }], flags: [] }),
		);
		yield* tickUntil('the posted follow-up', (runs, commands) => isRun(runs, (run) => run.job._tag === 'follow-up' && run.status === 'ended') && commands.every((found) => found.status === 'ended'));
		assert.strictEqual(h.linear.stateName(epic.id), 'To Review');

		// Cleanup: the PR is merged.
		h.github.setPullRequestState(h.githubRepo, pullRequest.number, 'MERGED');
		yield* tickUntil('the cleanup', (runs) => runs.length === 0);

		const comments = h.linear.comments(epic.id);
		const thread = h.github.thread(threadId);
		const settled = yield* Effect.forEach([command.threadId, followUpThread], (id) => h.t3.thread(id).pipe(Effect.map(Option.map((found) => found.settled))));

		return {
			crashed: crashed(),
			writes: writesSoFar(h),
			outcome: {
				linear: {
					state: h.linear.stateName(epic.id),
					labels: h.linear.labelNames(epic.id),
					comments: comments.map((comment) => markerOrFirstLine(comment.body)),
				},
				github: {
					comments: h.github.comments(h.githubRepo, pullRequest.number).map(markerOrFirstLine),
					thread: [thread.isResolved, thread.comments.map((comment) => markerOrFirstLine(comment.body))],
				},
				t3: {
					launches: (yield* h.t3.launches).map((launch) => launch.title),
					sends: (yield* h.t3.sends).map((send) => send.message),
					settled,
				},
				pushover: h.pushover.sent().map((message) => message.title),
				commands: (yield* h.commands).map((found) => `${found.status} ${found.author}`),
				git: { worktree: h.worktrees().includes(worktreePath), branch: h.hasBranch(branch) },
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
		'one epic from Ready For Agent to its merged PR ends the same, with nothing posted twice, after a crash at any write',
		() =>
			Effect.gen(function* () {
				const uncrashed = yield* lifecycle(Option.none());
				const followUpAt = 60_000;
				const pullRequestUrl = 'https://github.com/test/repo/pull/1';

				assert.deepStrictEqual(uncrashed.outcome, {
					linear: {
						state: 'To Review',
						labels: [],
						comments: [`pullRequestOpened:${pullRequestUrl}`, 'summary:0', 'flags:0', `summary:${followUpAt}`],
					},
					github: {
						comments: ['commandReply:1', `addressed:${followUpAt}`],
						thread: [true, ['Rename this to syncSettings. @orchestratorbot', `reply:PRRT_1.${followUpAt}`]],
					},
					t3: { launches: ['TEST-10 Plugin settings sync', 'CMD-1', 'TEST-10 Plugin settings sync'], sends: [], settled: [Option.some(true), Option.some(true)] },
					pushover: [],
					commands: ['ended marioparaschiv'],
					git: { worktree: false, branch: false },
					runs: 0,
				});

				const points = writeKinds.flatMap((kind) => Array.from({ length: uncrashed.writes[kind] }, (_, index): CrashPoint => ({ kind, nth: index + 1 })));

				for (const point of yield* Random.shuffle(points).pipe(Random.withSeed(seed))) {
					const { crashed, outcome } = yield* lifecycle(Option.some(point));

					assert.isTrue(crashed, `${describePoint(point)} never happened`);
					assert.deepStrictEqual(outcome, uncrashed.outcome, describePoint(point));
				}
			}),
		{ timeout: 120_000 },
	);
});
