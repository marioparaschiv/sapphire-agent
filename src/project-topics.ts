import { Effect } from 'effect';
import { Chat } from './chat.ts';
import type { Project } from './journal.ts';
import type { Rule, TaskWork } from './planner.ts';
import { Projects } from './projects.ts';

// Gives each project its own thread in the chat for as long as it exists: opened once the project is added, and again
// whenever it is gone, e.g. deleted by the user. Removing a project deletes it (requests rule). A chat failure is
// retried next tick. Not pausable.
export const projectTopicsRule = Effect.gen(function* () {
	const chat = yield* Chat;
	const projects = yield* Projects;

	const open = (project: Project) =>
		Effect.gen(function* () {
			const thread = yield* chat.openProject(project.team);

			yield* projects.put({ ...project, thread });
			yield* Effect.log(`opened the chat thread of project ${project.team}`);
		});

	const plan = () =>
		Effect.gen(function* () {
			const all = yield* projects.list;
			const opened = all.flatMap(({ thread }) => (thread === null ? [] : [thread]));
			const missing = opened.length === 0 ? [] : yield* chat.missingThreads(opened);

			return all
				.filter(({ thread }) => thread === null || missing.includes(thread))
				.map((project): TaskWork => ({ task: `${project.team} thread`, apply: open(project) }));
		});

	return { name: 'project topics', pausable: false, plan } satisfies Rule;
});
