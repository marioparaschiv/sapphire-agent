import { join } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Stream } from 'effect';
import { AppConfig } from './config.ts';
import { Herdr } from './herdr.ts';
import { Journal } from './journal.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Reconciler } from './reconciler.ts';

const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(join(env.stateDirectory, 'journal.db'))));

const MainLive = Reconciler.layer.pipe(
	Layer.provide(Planner.layer(Effect.succeed([]))),
	Layer.provide(Pause.layer),
	Layer.provideMerge(Herdr.layer),
	Layer.provideMerge(JournalLive),
	Layer.provideMerge(AppConfig.layer),
	Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
	const config = yield* AppConfig;
	const reconciler = yield* Reconciler;
	const herdr = yield* Herdr;

	yield* Effect.log(`watching ${Object.keys(config.teams).join(', ')} every ${config.pollSeconds}s, at most ${config.maxInFlight} in flight`);

	yield* Effect.forkChild(Stream.runForEach(herdr.events, () => reconciler.wake));

	return yield* reconciler.run;
});

NodeRuntime.runMain(program.pipe(Effect.provide(MainLive)));
