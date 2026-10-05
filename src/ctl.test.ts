import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Refused } from './ctl.ts';
import { Journal, type Run } from './journal.ts';
import { deliveries, makeHarness } from './test-harness.ts';

const run: Run = {
	epicId: 'issue-unb-12',
	identifier: 'UNB-12',
	teamId: 'team-unbound',
	status: 'running',
	job: { _tag: 'orchestrate' },
	repo: '/home/dev/unbound',
	branch: 'mario/unb-12-settings-sync',
	worktreePath: '/home/dev/.herdr/worktrees/unbound/mario-unb-12-settings-sync',
	tabId: 'w1:t3',
	paneId: 'w1:p3',
	claimedAt: Date.UTC(2026, 9, 4, 9, 30),
	startedAt: Date.UTC(2026, 9, 4, 9, 31),
	agentStatus: 'working',
	agentStatusSince: Date.UTC(2026, 9, 4, 9, 40),
	nudgedAt: null,
	tailHash: null,
	result: null,
	questionCommentId: null,
	deliveredReplyIds: [],
};

// `scripts/ctl.sh <args>` as a separate process, with the state and config in `directory`.
const ctlSh = (directory: string, ...args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make('sh', [join(import.meta.dirname, '..', 'scripts', 'ctl.sh'), ...args], {
				extendEnv: false,
				env: {
					PATH: process.env.PATH,
					HOME: directory,
					HERDR_PLUGIN_STATE_DIR: directory,
					HERDR_PLUGIN_CONFIG_DIR: directory,
					SAPPHIRE_AGENT_LINEAR_KEY_FILE: join(directory, 'linear-key'),
				},
			}),
		);
		const [stdout, stderr] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 'unbounded' });

		return { stdout, stderr, exitCode: yield* handle.exitCode };
	});

describe('ctl', () => {
	it.effect("start moves the epic to its team's ready state, says when the stuck label holds it back, and wakes the service", () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const stuck = h.linear.addLabel({ name: 'agent-stuck' });
			const reviewed = h.linear.addEpic({ identifier: 'TEST-20', title: 'Reviewed', state: 'To Review' });
			const held = h.linear.addEpic({ identifier: 'TEST-21', title: 'Held', state: 'To Do', labelIds: [stuck.id] });
			const ready = h.linear.addEpic({ identifier: 'TEST-22', title: 'Ready' });

			assert.deepStrictEqual(yield* h.ctl('start', 'test-20'), ['TEST-20 is in Ready For Agent; it is dispatched once a slot is free']);
			assert.deepStrictEqual(yield* h.ctl('start', 'TEST-21'), ['TEST-21 is in Ready For Agent, but it has the agent-stuck label, so it is not dispatched until that is removed']);
			assert.deepStrictEqual(yield* h.ctl('start', 'TEST-22'), ['TEST-22 is in Ready For Agent; it is dispatched once a slot is free']);
			assert.deepStrictEqual(yield* h.ctl('start', 'TEST-99').pipe(Effect.flip), new Refused({ message: 'there is no epic TEST-99 in Linear' }));

			assert.deepStrictEqual([reviewed, held, ready].map((epic) => h.linear.stateName(epic.id)), ['Ready For Agent', 'Ready For Agent', 'Ready For Agent']);
			assert.deepStrictEqual(
				h.linear.mutations.filter((mutation) => mutation.startsWith('move')).map((mutation) => mutation.split(' ')[1]),
				[reviewed.id, held.id],
			);
			assert.isTrue(existsSync(join(h.dir, 'wake')));
		}),
	);

	it.effect('status prints each run with its epic state, the commands in flight and the requests waiting', () =>
		Effect.gen(function* () {
			const h = yield* makeHarness();
			const { epic, run: started } = yield* h.startedRun({ identifier: 'TEST-10', title: 'Plugin settings sync' });
			const { number } = h.github.addPullRequest({ repo: h.githubRepo, branch: epic.branchName, author: 'marioparaschiv' });
			const mention = h.github.addComment(h.githubRepo, number, '@orchestratorbot stop TEST-10');

			yield* h.deliver(deliveries.issueComment(h.githubRepo, number, mention));
			yield* h.tick;
			yield* h.ctl('send', 'TEST-10', 'Wrap', 'up.');
			yield* h.ctl('follow-up', 'TEST-10', '--threads', 'PRRT_1', 'Rename', 'it.');

			assert.deepStrictEqual(yield* h.ctl('status'), [
				`TEST-10 running (orchestrate), epic in Implementing, claimed 1970-01-01T00:00:00.000Z, tab ${started.tabId}, ${started.worktreePath}`,
				`CMD-1 running, @marioparaschiv in ${mention.url}`,
				'request 1: send TEST-10: Wrap up.',
				'request 2: follow-up TEST-10 threads PRRT_1: Rename it.',
			]);
		}),
	);

	it.live('as its own process, records a request and wakes the service, or refuses on stderr with exit code 1; pause and resume wake it too', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();

			yield* fs.writeFileString(
				join(directory, 'config.json'),
				JSON.stringify({ teams: { Unbound: { repo: join(directory, 'unbound') } }, bot: { login: 'orchestratorbot', app: { id: 424242, privateKeyFile: join(directory, 'app.pem'), webhookSecretFile: join(directory, 'webhook-secret') }, allowedUsers: ['marioparaschiv'] } }),
			);
			yield* fs.writeFileString(join(directory, 'linear-key'), 'lin_api_secret', { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'app.pem'), generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey, { mode: 0o600 });
			yield* fs.writeFileString(join(directory, 'webhook-secret'), 'whsec_test', { mode: 0o600 });
			yield* Journal.use((journal) => journal.putRun(run)).pipe(Effect.provide(Journal.layer(join(directory, 'journal.db'))));

			assert.deepStrictEqual(yield* ctlSh(directory, 'stop', 'UNB-13'), { stdout: '', stderr: 'UNB-13 has no run in flight\n', exitCode: ChildProcessSpawner.ExitCode(1) });
			assert.isFalse(existsSync(join(directory, 'wake')));

			assert.deepStrictEqual(yield* ctlSh(directory, 'stop', 'unb-12'), { stdout: "UNB-12's run is stopped and its tab closed on the next tick\n", stderr: '', exitCode: ChildProcessSpawner.ExitCode(0) });
			assert.deepStrictEqual(
				(yield* Journal.use((journal) => journal.listRequests).pipe(Effect.provide(Journal.layer(join(directory, 'journal.db'))))).map(({ request }) => request),
				[{ _tag: 'stop', identifier: 'UNB-12' }],
			);
			assert.isTrue(existsSync(join(directory, 'wake')));

			yield* fs.remove(join(directory, 'wake'));
			assert.strictEqual((yield* ctlSh(directory, 'pause')).stdout, 'dispatching paused; runs in flight are still watched\n');
			assert.isTrue(existsSync(join(directory, 'paused')) && existsSync(join(directory, 'wake')));
			yield* ctlSh(directory, 'resume');
			assert.isFalse(existsSync(join(directory, 'paused')));
			assert.strictEqual((yield* ctlSh(directory, 'merge')).exitCode, ChildProcessSpawner.ExitCode(2));
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
