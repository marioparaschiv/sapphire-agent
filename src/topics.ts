import { Effect, Option, Semaphore } from 'effect';
import { Chat, type EpicState } from './chat.ts';
import { Git } from './git.ts';
import { GitHub } from './github.ts';
import { Journal, type Run, type Topic } from './journal.ts';
import { type Epic, Linear } from './linear.ts';
import { activeRoles, hasRole, isInFlight, type Observation } from './observation.ts';
import type { Rule, TaskWork } from './planner.ts';

// What the epic's thread should show, or none once it should be gone: a run in flight or failed shows its state; with
// no run in flight the thread waits on the review (To Review, In Review), and goes once the epic is anywhere else, e.g.
// its run was stopped. The results rule moves a finished run's epic to To Review after this tick's observation was
// made, so a run with a result still seen in Implementing waits on the review too.
export const topicState = (observation: Observation, epic: Epic, run: Option.Option<Run>): Option.Option<EpicState> => {
	if (Option.isSome(run)) {
		switch (run.value.status) {
			case 'claimed':
			case 'running':
				return Option.some('working');
			case 'awaitingInput':
				return Option.some('awaitingInput');
			case 'stale':
			case 'error':
				return Option.some('error');
		}
	}

	const finished = Option.exists(run, (found) => found.result !== null);

	return hasRole(observation, epic, finished ? ['toReview', 'inReview', 'implementing'] : ['toReview', 'inReview']) ? Option.some('review') : Option.none();
};

// Gives each running epic a thread in the chat, made when its run is dispatched, which shows the run's state, posts
// its PR once it opens, and goes once the epic ships (with a summary line in the archive thread) or its run stops. Its
// work is a task, not the epic's: the chat failing never flags the epic, and is tried again next tick. Not pausable.
export const topicsRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const chat = yield* Chat;
	const git = yield* Git;
	const github = yield* GitHub;
	const linear = yield* Linear;
	const archiveLock = yield* Semaphore.make(1);

	// Two epics shipping in the same tick share one archive thread.
	const archiveThread = archiveLock.withPermits(1)(
		Effect.gen(function* () {
			const existing = yield* journal.archiveThread;

			if (Option.isSome(existing)) {
				return existing.value;
			}

			const thread = yield* chat.openArchive;

			yield* journal.setArchiveThread(thread);

			return thread;
		}),
	);

	const open = (epic: Epic, state: EpicState) =>
		Effect.gen(function* () {
			const thread = yield* chat.openEpic(epic, state);

			yield* journal.putTopic({ epicId: epic.id, identifier: epic.identifier, thread, state, pullRequestUrl: null });
			yield* Effect.log('opened its chat thread');
		});

	const close = (topic: Topic) =>
		Effect.gen(function* () {
			yield* chat.send({ _tag: 'closeThread', thread: topic.thread });
			yield* journal.deleteTopic(topic.epicId);
			yield* Effect.log('closed its chat thread');
		});

	const ship = (topic: Topic, epic: Epic) =>
		Effect.gen(function* () {
			const archive = yield* archiveThread;
			const slices = yield* linear.subIssueCount(epic.id);

			yield* chat.send({ _tag: 'epicShipped', archive, epic, pullRequestUrl: topic.pullRequestUrl, slices });
			yield* close(topic);
		});

	const postPullRequest = (topic: Topic, epic: Epic, run: Run): Effect.Effect<Topic, unknown> =>
		Effect.gen(function* () {
			const repo = yield* git.githubRepo(run.repo);
			const pullRequest = Option.filter(yield* github.findPullRequest(repo, run.branch), (found) => found.state !== 'CLOSED');

			if (Option.isNone(pullRequest)) {
				return topic;
			}

			yield* chat.send({ _tag: 'pullRequestOpened', thread: topic.thread, epic, url: pullRequest.value.url });

			const posted = { ...topic, pullRequestUrl: pullRequest.value.url };

			yield* journal.putTopic(posted);

			return posted;
		});

	const update = (topic: Topic, epic: Epic, run: Option.Option<Run>, state: EpicState) =>
		Effect.gen(function* () {
			const current = Option.isSome(run) && topic.pullRequestUrl === null ? yield* postPullRequest(topic, epic, run.value) : topic;

			if (current.state === state) {
				return;
			}

			yield* chat.send({ _tag: 'epicState', thread: current.thread, epic, state });
			yield* journal.putTopic({ ...current, state });
		});

	const reconcile = (observation: Observation, topic: Topic, run: Option.Option<Run>): Option.Option<Effect.Effect<void, unknown>> => {
		const epic = observation.epics.get(topic.epicId);

		if (epic === undefined) {
			return Option.some(close(topic));
		}

		// A team that cannot be resolved this tick says nothing about where the epic is.
		if (!observation.teams.has(epic.team.id)) {
			return Option.none();
		}

		if (hasRole(observation, epic, ['shipped'])) {
			return Option.some(ship(topic, epic));
		}

		return Option.some(
			Option.match(topicState(observation, epic, run), {
				onNone: () => close(topic),
				onSome: (state) => update(topic, epic, run, state),
			}),
		);
	};

	const task = (identifier: string, apply: Effect.Effect<void, unknown>): TaskWork => ({ task: `${identifier} thread`, apply });

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const topics = yield* journal.listTopics;
			const runs = yield* journal.listRuns;
			const runOf = (epicId: string) => Option.fromUndefinedOr(runs.find((run) => run.epicId === epicId));
			const opened = runs
				.filter((run) => isInFlight(run) && !topics.some((topic) => topic.epicId === run.epicId))
				.flatMap((run) =>
					Option.toArray(
						Option.flatMap(Option.filter(Option.fromUndefinedOr(observation.epics.get(run.epicId)), (epic) => hasRole(observation, epic, activeRoles(run))), (epic) =>
							Option.map(topicState(observation, epic, Option.some(run)), (state) => task(epic.identifier, open(epic, state))),
						),
					),
				);
			const reconciled = topics.flatMap((topic) => Option.toArray(Option.map(reconcile(observation, topic, runOf(topic.epicId)), (apply) => task(topic.identifier, apply))));

			return [...opened, ...reconciled];
		});

	return { name: 'topics', pausable: false, plan } satisfies Rule;
});
