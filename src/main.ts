import { basename } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { AgentActivity } from './agent-activity.ts';
import { AgentEventServer } from './agent-event-server.ts';
import { ClaudeTranscript } from './claude-transcript.ts';
import { Comments } from './comments.ts';
import { AppConfig, PushoverConfig, T3Config } from './config.ts';
import { wakeForEpicEdits } from './epic-edits.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { GitHubApp } from './github-app.ts';
import { Journal, journalPath } from './journal.ts';
import { refuseUndrainedClaims } from './legacy-claims.ts';
import { Linear } from './linear.ts';
import { Observer } from './observation.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Projects } from './projects.ts';
import { Prompts } from './prompts.ts';
import { Pushover } from './pushover.ts';
import { Reconciler, wakeFileName } from './reconciler.ts';
import { rules } from './rules.ts';
import { Summariser } from './summariser.ts';
import { T3 } from './t3.ts';
import { T3Projects } from './t3-projects.ts';
import { checkT3Settings } from './t3-settings.ts';
import { watchThreads } from './thread-waits.ts';
import { WebhookServer } from './webhook-server.ts';

const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(journalPath(env.stateDirectory))));

const ServicesLive = Layer.mergeAll(Linear.layer(), GitHub.layer, Git.layer, ClaudeTranscript.layer, Comments.layer, Pushover.layer(), Summariser.layer).pipe(
	Layer.provideMerge(Prompts.layer),
	Layer.provideMerge(GitHubApp.layer()),
);

const MainLive = Layer.mergeAll(WebhookServer.layer, AgentEventServer.layer).pipe(
	Layer.provideMerge(Reconciler.layer.pipe(Layer.provide(Planner.layer(rules).pipe(Layer.provide(Observer.layer))), Layer.provide(Pause.layer))),
	Layer.provideMerge(ServicesLive),
	Layer.provideMerge(Layer.mergeAll(Projects.layer, T3Projects.layer, AgentActivity.layer)),
	Layer.provideMerge(T3.layer.pipe(Layer.provide(T3Config.layer))),
	Layer.provideMerge(JournalLive),
	Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
	const config = yield* AppConfig;
	const reconciler = yield* Reconciler;
	const projects = yield* Projects;
	const fs = yield* FileSystem.FileSystem;
	const watched = yield* projects.list;

	yield* Effect.log(`watching ${watched.map(({ team }) => team).join(', ') || 'no projects'} every ${config.pollSeconds}s, at most ${config.maxInFlight} in flight`);

	yield* checkT3Settings;
	yield* Effect.forkChild(watchThreads);
	yield* Effect.forkChild(wakeForEpicEdits);
	// A project the requests rule changed is observed on the tick after.
	yield* Effect.forkChild(Stream.runForEach(Stream.drop(projects.changes, 1), () => reconciler.wake));
	yield* Effect.forkChild(
		fs.watch(config.env.stateDirectory).pipe(
			Stream.filter((event) => basename(event.path) === wakeFileName),
			Stream.runForEach(() => reconciler.wake),
			Effect.catch((error) => Effect.logWarning(`cannot watch ${config.env.stateDirectory}; ctl.sh requests wait for the next poll`, error)),
		),
	);

	return yield* reconciler.run;
});

// Refused before the services are built, which reaches out to GitHub.
NodeRuntime.runMain(refuseUndrainedClaims.pipe(Effect.andThen(program.pipe(Effect.provide(MainLive))), Effect.provide(PushoverConfig.layerWithAppConfig.pipe(Layer.provideMerge(NodeServices.layer)))));
