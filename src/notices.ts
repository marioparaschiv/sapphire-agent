import { Effect, Option } from 'effect';
import { Chat, type ThreadRef } from './chat.ts';
import { type Command, commandIdentifier, Journal, type Project, type Topic, type UnsentNotice } from './journal.ts';
import type { Observation } from './observation.ts';
import type { Rule } from './planner.ts';
import { Projects, projectInRepo } from './projects.ts';

// The project a notice is about: the one of the team whose key starts the epic's identifier, or the one of the repo a
// command runs in.
const projectOf = (observation: Observation, projects: ReadonlyArray<Project>, commands: ReadonlyArray<Command>, identifier: string): Option.Option<Project> => {
	const team = [...observation.teams.values()].find(({ team }) => identifier.startsWith(`${team.key}-`));

	if (team !== undefined) {
		return Option.fromUndefinedOr(projects.find((project) => project.team === team.team.name));
	}

	const cwd = commands.find((command) => commandIdentifier(command) === identifier)?.cwd ?? null;

	return cwd === null ? Option.none() : projectInRepo(projects, cwd);
};

// The epic's thread while it is open, else its project's, else the main chat (null).
const noticeThread = (
	observation: Observation,
	{ topics, projects, commands }: { readonly topics: ReadonlyArray<Topic>; readonly projects: ReadonlyArray<Project>; readonly commands: ReadonlyArray<Command> },
	identifier: string,
): ThreadRef | null =>
	topics.find((topic) => topic.identifier === identifier)?.thread ??
	Option.getOrNull(Option.flatMap(projectOf(observation, projects, commands, identifier), (project) => Option.fromNullOr(project.thread)));

// Sends the notices in the journal's outbox, oldest first, each keyed by its marker so the chat shows it once, then
// marks it sent: a crash in between sends it again, which the chat ignores. Telegram being down stops the rest until the
// next tick. A thread the chat refuses (e.g. deleted by the user) gets its notice in the main chat instead. Runs after
// the topic rules, so a thread opened this tick gets this tick's notices. Not pausable.
export const noticesRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const chat = yield* Chat;
	const projects = yield* Projects;

	const send = (notice: UnsentNotice, thread: ThreadRef | null) => {
		const key = `${notice.identifier}:${notice.purpose}:${notice.key}`;
		const post = (to: ThreadRef | null) => chat.send({ _tag: 'notice', thread: to, text: notice.text, key });

		return post(thread).pipe(
			Effect.catchTag('Permanent', (error) =>
				thread === null ? Effect.fail(error) : Effect.logWarning(`cannot post notice ${key} in ${thread}; posting it in the main chat`, error).pipe(Effect.andThen(post(null))),
			),
			Effect.andThen(journal.markNoticeSent(notice.id)),
			Effect.catchTag('Permanent', (error) => Effect.logError(`cannot post notice ${key}; trying again next tick`, error)),
		);
	};

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const notices = yield* journal.unsentNotices;

			if (notices.length === 0) {
				return [];
			}

			const routes = { topics: yield* journal.listTopics, projects: yield* projects.list, commands: yield* journal.listCommands };

			return [{ task: 'notices', apply: Effect.forEach(notices, (notice) => send(notice, noticeThread(observation, routes, notice.identifier)), { discard: true }) }];
		});

	return { name: 'notices', pausable: false, plan } satisfies Rule;
});
