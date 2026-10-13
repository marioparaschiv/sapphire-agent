import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Stream } from 'effect';
import { CliError } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Refused } from './ctl.ts';
import { Journal, type Run } from './journal.ts';
import { otherTeam } from './linear-fixture.ts';
import { t3TokenExpiring } from './t3-fake.ts';
import { deliveries, makeHarness } from './test-harness.ts';

const run: Run = {
	epicId: 'issue-unb-12',
	identifier: 'UNB-12',
	teamId: 'team-unbound',
	status: 'running',
	job: { _tag: 'orchestrate' },
	repo: '/home/dev/unbound',
	branch: 'mario/unb-12-settings-sync',
	worktreePath: '/home/dev/.t3/worktrees/unbound/mario-unb-12-settings-sync',
	session: { id: '3f9a6c12-8e4b-4d71-b0a5-6c2e9f8d1b47', name: 'unb-12' },
	replyTo: null,
	claimedAt: Date.UTC(2026, 9, 4, 9, 30),
	startedAt: Date.UTC(2026, 9, 4, 9, 31),
	agentStatus: 'working',
	agentStatusSince: Date.UTC(2026, 9, 4, 9, 40),
	nudgedAt: null,
	result: null,
	handoff: null,
	threadId: 'thread-unb-12',
	threadRunId: 'run-unb-12-1',
	threadSettledAt: null,
};

// `scripts/ctl.sh <args>` as a separate process with `home` as HOME and no other environment but PATH, so it finds the
// config and the state at their default paths there.
const ctlSh = (home: string, ...args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make('sh', [join(import.meta.dirname, '..', 'scripts', 'ctl.sh'), ...args], {
				extendEnv: false,
				env: { PATH: process.env.PATH, HOME: home },
			}),
		);
		const [stdout, stderr] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 'unbounded' });

		return { stdout, stderr, exitCode: yield* handle.exitCode };
	});

describe('ctl', () => {
	it.effect("dispatch moves the epic to its team's ready state, says when the stuck label holds it back, refuses a sub-issue, an unknown issue and an epic whose run is not over but dispatches one whose run ended, and wakes the service", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic: finished, run: finishedRun } = yield* h.threadRun({ identifier: 'TEST-24', title: 'Finished' });

			yield* Journal.use((journal) => journal.putRun({ ...finishedRun, status: 'ended' })).pipe(Effect.provide(Journal.layer(join(h.dir, 'journal.db'))));
			yield* h.threadRun({ identifier: 'TEST-23', title: 'Running' });

			const stuck = h.linear.addLabel({ name: 'agent-stuck' });
			const reviewed = h.linear.addEpic({ identifier: 'TEST-20', title: 'Reviewed', state: 'To Review' });
			const held = h.linear.addEpic({ identifier: 'TEST-21', title: 'Held', state: 'To Do', labelIds: [stuck.id] });
			const ready = h.linear.addEpic({ identifier: 'TEST-22', title: 'Ready' });
			const mutationsBefore = h.linear.mutations.length;

			assert.deepStrictEqual(yield* h.ctl('dispatch', 'test-20', '--reply-to', 'planning'), ['TEST-20 is in Ready For Agent; it is dispatched once a slot is free']);
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-21'), ['TEST-21 is in Ready For Agent, but it has the agent-stuck label, so it is not dispatched until that is removed']);
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-22'), ['TEST-22 is in Ready For Agent; it is dispatched once a slot is free']);
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-221').pipe(Effect.flip), new Refused({ message: 'TEST-221 is a sub-issue of TEST-22; dispatch TEST-22 instead' }));
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-99').pipe(Effect.flip), new Refused({ message: 'there is no issue TEST-99 in Linear' }));
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-23', '--reply-to', 'planning').pipe(Effect.flip), new Refused({ message: 'TEST-23 has a run that is not over' }));
			assert.deepStrictEqual(yield* h.ctl('dispatch', 'TEST-24'), ['TEST-24 is in Ready For Agent; it is dispatched once a slot is free']);
			assert.deepStrictEqual(
				yield* h.ctl('dispatch', 'TEST-22', '--reply-to', ' ').pipe(Effect.flip),
				new CliError.ShowHelp({ commandPath: ['ctl', 'dispatch'], errors: [new CliError.InvalidValue({ option: 'reply-to', value: ' ', expected: 'a session name', kind: 'flag' })] }),
			);
			assert.deepStrictEqual(
				(yield* h.ctl('status')).filter((line) => line.startsWith('request')),
				['request 1: dispatch TEST-20 reply-to planning', 'request 2: dispatch TEST-21', 'request 3: dispatch TEST-22', 'request 4: dispatch TEST-24'],
			);

			assert.deepStrictEqual([reviewed, held, ready].map((epic) => h.linear.stateName(epic.id)), ['Ready For Agent', 'Ready For Agent', 'Ready For Agent']);
			assert.deepStrictEqual(
				h.linear.mutations.slice(mutationsBefore).filter((mutation) => mutation.startsWith('move')).map((mutation) => mutation.split(' ')[1]),
				[reviewed.id, held.id, finished.id],
			);
			assert.isTrue(existsSync(join(h.dir, 'wake')));
		}),
	);

	it.effect('status prints whether dispatching is paused, the projects, each run with its epic state, the ready epics held with what blocks them, the commands in flight and the requests waiting', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { run: started } = yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const otherTeamBlocker = h.linear.addEpic({ identifier: 'OPS-3', title: 'Rotate the API keys', teamId: otherTeam.id, state: 'In Progress', subIssues: 0 });
			const blocker = h.linear.addEpic({ identifier: 'TEST-9', title: 'Retry policy', state: 'To Do', subIssues: 0 });
			const finished = h.linear.addEpic({ identifier: 'TEST-8', title: 'Old HTTP client', state: 'Done', subIssues: 0 });

			h.linear.addEpic({
				identifier: 'TEST-11',
				title: 'Linear service on HttpClient',
				inverseRelations: [
					{ type: 'blocks', issueId: otherTeamBlocker.id },
					{ type: 'blocks', issueId: blocker.id },
					{ type: 'blocks', issueId: finished.id },
				],
			});
			h.linear.addEpic({ identifier: 'TEST-12', title: 'Unblocked', inverseRelations: [{ type: 'blocks', issueId: finished.id }] });
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch: started.branch, author: 'marioparaschiv' });
			const mention = h.github.addComment(h.githubRepo, number, '@orchestratorbot stop TEST-10');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, mention));
			yield* h.tick;
			yield* h.ctl('send', 'TEST-10', 'Wrap', 'up.');
			yield* h.ctl('follow-up', 'TEST-10', '--threads', 'PRRT_1', 'Rename', 'it.');

			assert.deepStrictEqual(yield* h.ctl('status'), [
				'dispatching: active',
				`project Test: ${h.repo}`,
				`TEST-10 running (orchestrate), epic in Implementing, claimed 1970-01-01T00:00:00.000Z, T3 thread ${started.threadId}, session test-10, ${started.worktreePath}`,
				'TEST-11 held by OPS-3, TEST-9',
				`CMD-1 running, @marioparaschiv in ${mention.url}`,
				'request 1: send TEST-10: Wrap up.',
				'request 2: follow-up TEST-10 threads PRRT_1: Rename it.',
			]);

			yield* h.ctl('pause');
			assert.strictEqual((yield* h.ctl('status'))[0], 'dispatching: paused');
		}),
	);

	it.effect("session prints the Claude session name of the epic's run, and refuses an epic with no run", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();

			yield* h.threadRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });

			assert.deepStrictEqual(yield* h.ctl('session', 'test-10'), ['test-10']);
			assert.deepStrictEqual(yield* h.ctl('session', 'TEST-11').pipe(Effect.flip), new Refused({ message: 'TEST-11 has no run' }));
		}),
	);

	it.effect("t3 status says until when the token is accepted and the T3 project of each project's repo, creating a missing one once; it refuses while T3 rejects the token", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const first = yield* h.ctl('t3', 'status');
			const second = yield* h.ctl('t3', 'status');
			const [created] = yield* h.t3.projects;

			const accepted = 'token: accepted, expires 2036-10-04T12:00:00.000Z';
			const projectLine = `project Test: ${h.repo} is T3 project ${created.id} (repo)`;

			// The creation is logged, behind the log line's time and fiber.
			assert.deepStrictEqual(
				first.filter((line) => !line.startsWith('[')),
				[accepted, `created T3 project ${created.id} for ${h.repo}`, projectLine],
			);
			assert.deepStrictEqual(second, [accepted, projectLine]);
			assert.deepStrictEqual((yield* h.t3.projects).map(({ workspaceRoot }) => workspaceRoot), [h.repo]);

			yield* h.t3.rejectToken(true);
			assert.deepStrictEqual(
				yield* h.ctl('t3', 'status').pipe(Effect.flip),
				new Refused({ message: `T3 rejects the token in ${join(homedir(), '.config/sapphire-agent/t3-token')}, which expires 2036-10-04T12:00:00.000Z; run scripts/mint-t3-token.sh again` }),
			);
		}),
	);

	it.live('as its own process without environment variables, records a request and wakes the service, or refuses on stderr with exit code 1; pause and resume wake it too', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const home = yield* fs.makeTempDirectoryScoped();
			const directory = join(home, '.config/sapphire-agent');
			const state = join(home, '.local/state/sapphire-agent');

			yield* fs.makeDirectory(directory, { recursive: true });
			yield* fs.makeDirectory(state, { recursive: true });

			yield* fs.writeFileString(
				join(directory, 'config.json'),
				JSON.stringify({ teams: { Unbound: { repo: join(directory, 'unbound') } }, linearWebhookSecretFile: join(directory, 'linear-webhook-secret'), bot: { login: 'orchestratorbot', app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') }, allowedUsers: ['marioparaschiv'] } }),
			);
			yield* fs.writeFileString(join(directory, 'linear-key'), 'lin_api_secret', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 't3-token'), t3TokenExpiring(Date.UTC(2036, 9, 4)), { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'app.pem'), generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey, { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'webhook-secret'), 'whsec_test', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'linear-webhook-secret'), 'lin_wh_test', { mode: 0o600 });
			yield* Journal.use((journal) => journal.putRun(run)).pipe(Effect.provide(Journal.layer(join(state, 'journal.db'))));

			assert.deepStrictEqual(yield* ctlSh(home, 'stop', 'UNB-13'), { stdout: '', stderr: 'UNB-13 has no run in flight\n', exitCode: ChildProcessSpawner.ExitCode(1) });
			assert.isFalse(existsSync(join(state, 'wake')));

			assert.deepStrictEqual(yield* ctlSh(home, 'session', 'unb-12'), { stdout: 'unb-12\n', stderr: '', exitCode: ChildProcessSpawner.ExitCode(0) });
			assert.deepStrictEqual(yield* ctlSh(home, 'ctl', 'session', 'UNB-13'), { stdout: '', stderr: 'UNB-13 has no run\n', exitCode: ChildProcessSpawner.ExitCode(1) });

			assert.deepStrictEqual(yield* ctlSh(home, 'stop', 'unb-12'), { stdout: "UNB-12's run is stopped and its T3 thread interrupted on the next tick\n", stderr: '', exitCode: ChildProcessSpawner.ExitCode(0) });
			assert.deepStrictEqual(
				(yield* Journal.use((journal) => journal.listRequests).pipe(Effect.provide(Journal.layer(join(state, 'journal.db'))))).map(({ request }) => request),
				[{ _tag: 'stop', identifier: 'UNB-12' }],
			);
			assert.isTrue(existsSync(join(state, 'wake')));

			yield* fs.remove(join(state, 'wake'));
			assert.strictEqual((yield* ctlSh(home, 'pause')).stdout, 'dispatching paused; runs in flight are still watched\n');
			assert.isTrue(existsSync(join(state, 'paused')) && existsSync(join(state, 'wake')));
			yield* fs.remove(join(state, 'wake'));
			assert.strictEqual((yield* ctlSh(home, 'resume')).stdout, 'dispatching resumed\n');
			assert.isTrue(!existsSync(join(state, 'paused')) && existsSync(join(state, 'wake')));
			assert.notStrictEqual((yield* ctlSh(home, 'merge')).exitCode, ChildProcessSpawner.ExitCode(0));
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
