import { basename, join } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { ClaudeTranscript } from './claude-transcript.ts';
import { ClaudeTrust } from './claude-trust.ts';
import { Comments } from './comments.ts';
import { AppConfig } from './config.ts';
import { answerChatMessages } from './conversations.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { GitHubApp } from './github-app.ts';
import { Herdr } from './herdr.ts';
import { Journal } from './journal.ts';
import { refuseUndrainedClaims } from './legacy-claims.ts';
import { Linear } from './linear.ts';
import { MissedDeliveries } from './missed-deliveries.ts';
import { Observer } from './observation.ts';
import { Pause } from './pause.ts';
import { Planner } from './planner.ts';
import { Prompts } from './prompts.ts';
import { Reconciler, wakeFileName } from './reconciler.ts';
import { rules } from './rules.ts';
import { telegramChat } from './telegram.ts';
import { TelegramBot } from './telegram-bot.ts';
import { WebhookServer } from './webhook-server.ts';

const JournalLive = Layer.unwrap(AppConfig.useSync(({ env }) => Journal.layer(join(env.stateDirectory, 'journal.db'))));

const ServicesLive = Layer.mergeAll(Linear.layer(), GitHub.layer, Git.layer, ClaudeTrust.layer, ClaudeTranscript.layer, Herdr.layer, Comments.layer, Prompts.layer).pipe(Layer.provideMerge(GitHubApp.layer()));

const MainLive = Layer.mergeAll(WebhookServer.layer, MissedDeliveries.layer, telegramChat.pipe(Layer.provide(TelegramBot.layer))).pipe(
	Layer.provideMerge(Reconciler.layer.pipe(Layer.provide(Planner.layer(rules).pipe(Layer.provide(Observer.layer))), Layer.provide(Pause.layer))),
	Layer.provideMerge(ServicesLive),
	Layer.provideMerge(JournalLive),
	Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
	const config = yield* AppConfig;
	const reconciler = yield* Reconciler;
	const herdr = yield* Herdr;
	const missedDeliveries = yield* MissedDeliveries;
	const fs = yield* FileSystem.FileSystem;

	yield* Effect.log(`watching ${Object.keys(config.teams).join(', ')} every ${config.pollSeconds}s, at most ${config.maxInFlight} in flight`);

	yield* Effect.forkChild(Stream.runForEach(herdr.events, () => reconciler.wake));
	yield* Effect.forkChild(missedDeliveries.run);
	yield* Effect.forkChild(answerChatMessages);
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
NodeRuntime.runMain(refuseUndrainedClaims.pipe(Effect.andThen(program.pipe(Effect.provide(MainLive))), Effect.provide(AppConfig.layer.pipe(Layer.provideMerge(NodeServices.layer)))));
