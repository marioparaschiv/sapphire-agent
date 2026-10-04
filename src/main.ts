import { basename, join } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { ClaudeTrust } from './claude-trust.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { Herdr } from './herdr.ts';
import { Journal } from './journal.ts';
import { refuseUndrainedClaims } from './legacy-claims.ts';
import { Linear } from './linear.ts';
import { Observer } from './observation.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Prompts } from './prompts.ts';
import { Reconciler, wakeFileName } from './reconciler.ts';
import { rules } from './rules.ts';

const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(join(env.stateDirectory, 'journal.db'))));

const ServicesLive = Layer.mergeAll(Linear.layer(), GitHub.layer, Git.layer, ClaudeTrust.layer, Herdr.layer, Comments.layer, Prompts.layer);

const MainLive = Reconciler.layer.pipe(
	Layer.provide(Planner.layer(rules).pipe(Layer.provide(Observer.layer))),
	Layer.provide(Pause.layer),
	Layer.provideMerge(ServicesLive),
	Layer.provideMerge(JournalLive),
	Layer.provideMerge(AppConfig.layer),
	Layer.provide(FetchHttpClient.layer),
	Layer.provideMerge(NodeServices.layer),
);

const program = Effect.gen(function* () {
	const config = yield* AppConfig;
	const reconciler = yield* Reconciler;
	const herdr = yield* Herdr;
	const fs = yield* FileSystem.FileSystem;

	yield* refuseUndrainedClaims;
	yield* Effect.log(`watching ${Object.keys(config.teams).join(', ')} every ${config.pollSeconds}s, at most ${config.maxInFlight} in flight`);

	yield* Effect.forkChild(Stream.runForEach(herdr.events, () => reconciler.wake));
	yield* Effect.forkChild(
		fs.watch(config.env.stateDirectory).pipe(
			Stream.filter((event) => basename(event.path) === wakeFileName),
			Stream.runForEach(() => reconciler.wake),
			Effect.catch((error) => Effect.logWarning(`cannot watch ${config.env.stateDirectory}; ctl.sh requests wait for the next poll`, error)),
		),
	);

	return yield* reconciler.run;
});

NodeRuntime.runMain(program.pipe(Effect.provide(MainLive)));
