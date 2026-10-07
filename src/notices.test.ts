import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Journal } from './journal.ts';
import { LinearFixture } from './linear-fixture.ts';
import { noticesRule } from './notices.ts';
import { Planner } from './planner.ts';
import { type Harness, makeHarness, markerKeys, plannerDependencies } from './test-harness.ts';

const invalid = '🔴 **TEST-10 wrote an invalid result file**';

// A run whose agent stopped and left a result file that is not JSON, which the results rule flags with a notice.
const invalidResultRun = (h: Harness) =>
	Effect.gen(function* () {
		const started = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

		yield* h.t3.setRunStatus(started.run.threadId, 'completed');
		h.writeResultFile(started.run, '{ "summary": ');

		return started;
	});

describe('notices', () => {
	it.effect('posts a notice as a comment on its epic, ending with its marker, and marks it sent', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* invalidResultRun(h);

			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['invalidResult:0']);
			assert.isTrue(h.linear.comments(epic.id)[0].body.startsWith(`${invalid}\n`));
			assert.deepStrictEqual(
				h.notices('TEST-10').map(({ marker, sent }) => [marker, sent]),
				[['invalidResult:0', true]],
			);
		}),
	);

	it.effect('tries a notice Linear refused again next tick', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* invalidResultRun(h);

			// The stuck label is created and added first, then the comment is refused.
			h.linear.failWrite(h.linear.mutations.length + 3, 400);
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), []);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [false]);

			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['invalidResult:0']);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [true]);
		}),
	);

	it.effect('posts a notice exactly once when the process died after posting it and before marking it sent', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic } = yield* invalidResultRun(h);

			h.linear.failWrite(h.linear.mutations.length + 3, 400);
			yield* h.tick;
			h.crashAtJournalWrite(1);
			yield* h.tick;

			assert.isTrue(h.crashed());
			assert.deepStrictEqual(h.epicMarkers(epic.id), ['invalidResult:0']);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [false]);

			yield* h.restart;
			yield* h.tick;

			assert.deepStrictEqual(h.epicMarkers(epic.id), ['invalidResult:0']);
			assert.deepStrictEqual(h.notices('TEST-10').map(({ sent }) => sent), [true]);
		}),
	);

	it.effect('posts a notice on an epic the tick did not observe, and drops one whose epic Linear does not have', () =>
		Effect.gen(function* () {
			const linear = yield* LinearFixture;
			const journal = yield* Journal;
			const epic = linear.addEpic({ identifier: 'TEST-30', title: 'Docs', state: 'Shipped' });

			yield* journal.addNotice({ marker: { identifier: 'TEST-30', purpose: 'keptWorktree', key: '/worktrees/test-30' }, text: '📦 **Kept TEST-30\'s worktree**' });
			yield* journal.addNotice({ marker: { identifier: 'TEST-99', purpose: 'keptWorktree', key: '/worktrees/test-99' }, text: '📦 **Kept TEST-99\'s worktree**' });
			yield* Planner.use((planner) => planner.tick({ paused: false })).pipe(Effect.provide(Planner.layer(Effect.all([noticesRule]))));

			assert.deepStrictEqual(markerKeys(linear.comments(epic.id).map(({ body }) => body)), ['keptWorktree:/worktrees/test-30']);
			assert.deepStrictEqual(yield* journal.unsentNotices, []);
		}).pipe(Effect.provide(plannerDependencies('/tmp/sapphire-agent-notices-test'))),
	);
});
