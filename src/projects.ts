import { dirname } from 'node:path';
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from 'effect';
import { AppConfig } from './config.ts';
import { Journal, type JournalError, type Project } from './journal.ts';

// The project whose repo, or one of whose label repos, is the directory.
export const projectInRepo = (projects: ReadonlyArray<Project>, directory: string) =>
	Option.fromUndefinedOr(projects.find((project) => project.repo === directory || project.labelReposDirectory === dirname(directory)));

// The projects sapphire-agent watches, read from the journal at startup and kept in memory. The service is their only
// writer: `sapphire project` records requests, which the requests rule applies here.
export class Projects extends Context.Service<
	Projects,
	{
		// By team name.
		readonly list: Effect.Effect<ReadonlyArray<Project>>;
		readonly get: (team: string) => Effect.Effect<Option.Option<Project>>;
		// Inserts the project or replaces the one of the same team.
		readonly put: (project: Project) => Effect.Effect<void, JournalError>;
		readonly remove: (team: string) => Effect.Effect<void, JournalError>;
		// The projects now, then after every change.
		readonly changes: Stream.Stream<ReadonlyArray<Project>>;
	}
>()('sapphire-agent/Projects') {
	// While the journal has no projects, the teams of config.json are imported as projects.
	static readonly layer = Layer.effect(
		Projects,
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const journal = yield* Journal;
			const stored = yield* journal.listProjects;
			const imported =
				stored.length === 0
					? Object.entries(config.teams ?? {}).map(([team, { repo, labelReposDirectory }]): Project => ({ team, repo, labelReposDirectory: labelReposDirectory ?? null, thread: null }))
					: [];

			if (imported.length > 0) {
				yield* journal.putProjects(imported);
				yield* Effect.log(`imported the projects ${imported.map(({ team }) => team).join(', ')} from config.json's teams`);
			}

			if (config.teams !== undefined) {
				yield* Effect.logWarning("config.json still has teams, which are only read into an empty projects table; delete them and use `sapphire project` instead");
			}

			const projects = yield* SubscriptionRef.make(yield* journal.listProjects);
			const reload = journal.listProjects.pipe(Effect.flatMap((rows) => SubscriptionRef.set(projects, rows)));
			const list = SubscriptionRef.get(projects);

			return Projects.of({
				list,
				get: (team) => list.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows.find((project) => project.team === team)))),
				put: (project) => journal.putProjects([project]).pipe(Effect.andThen(reload)),
				remove: (team) => journal.deleteProject(team).pipe(Effect.andThen(reload)),
				changes: SubscriptionRef.changes(projects),
			});
		}),
	);
}
