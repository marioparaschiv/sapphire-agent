import { join } from 'node:path';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect, Layer } from 'effect';
import { Journal, type Run } from './journal.ts';

const describeRun = (run: Run) =>
	[
		`${run.identifier} ${run.status} (${run.job._tag})`,
		`claimed ${new Date(run.claimedAt).toISOString()}`,
		run.tabId === null ? 'no tab' : `tab ${run.tabId}`,
		run.worktreePath ?? 'no worktree',
	].join(', ');

// Prints the runs in the journal, for scripts/ctl.sh status.
const program = Effect.gen(function* () {
	const runs = yield* (yield* Journal).listRuns;

	yield* Console.log(runs.length === 0 ? 'no runs' : runs.map(describeRun).join('\n'));
});

const JournalLive = Layer.unwrap(Effect.map(Config.NonEmptyString('HERDR_PLUGIN_STATE_DIR'), (directory) => Journal.layer(join(directory, 'journal.db'))));

NodeRuntime.runMain(program.pipe(Effect.provide(JournalLive)));
