import { basename } from 'node:path';
import { Context, Effect, Layer, Option, Semaphore } from 'effect';
import { toPath } from './config.ts';
import { Journal, type JournalError } from './journal.ts';
import { T3, type T3Error } from './t3.ts';

// The T3 project of each local clone runs go to, a team's repo or a label repo: the one the journal remembers, else the
// one T3 has for that workspace root, else a new one. Lookups run one at a time, so two dispatches to a repo without a
// project never create it twice.
export class T3Projects extends Context.Service<
	T3Projects,
	{
		// The T3 project id of the repo.
		readonly projectFor: (repo: string) => Effect.Effect<string, T3Error | JournalError>;
	}
>()('sapphire-agent/T3Projects') {
	static readonly layer = Layer.effect(
		T3Projects,
		Effect.gen(function* () {
			const t3 = yield* T3;
			const journal = yield* Journal;
			const lookups = yield* Semaphore.make(1);

			const find = (repo: string) =>
				Effect.gen(function* () {
					const existing = (yield* t3.listProjects).find((project) => toPath(project.workspaceRoot) === repo);

					if (existing !== undefined) {
						return existing.id;
					}

					const created = yield* t3.createProject({ title: basename(repo), workspaceRoot: repo });

					yield* Effect.log(`created T3 project ${created.id} for ${repo}`);

					return created.id;
				});

			const projectFor = (repo: string) =>
				lookups.withPermit(
					Effect.gen(function* () {
						const remembered = yield* journal.getT3Project(repo);

						if (Option.isSome(remembered)) {
							return remembered.value;
						}

						const projectId = yield* find(repo);

						yield* journal.putT3Project({ repo, projectId });

						return projectId;
					}),
				);

			return T3Projects.of({ projectFor });
		}),
	);
}
