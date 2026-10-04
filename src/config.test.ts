import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configSchema, loadConfig, resolveRepo } from './config.ts';

async function load(t: { after: (fn: () => void) => void }, contents: string) {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-config-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'config.json');
	writeFileSync(path, contents);

	return loadConfig(path);
}

test('fills defaults and expands ~ in repo paths', async (t) => {
	const config = await load(t, JSON.stringify({ teams: { Telecord: { repo: '~/telecord' } } }));

	assert.equal(config.pollSeconds, 30);
	assert.equal(config.maxInFlight, 1);
	assert.equal(config.staleAfterSeconds, 600);
	assert.equal(config.nudgeGraceSeconds, 600);
	assert.equal(config.maxRunSeconds, 5400);
	assert.equal(config.states.ready, 'Ready For Agent');
	assert.equal(config.labels.stuck, 'agent-stuck');
	assert.equal(config.teams.Telecord.repo, join(homedir(), 'telecord'));
	assert.equal(config.worktreesDirectory, join(homedir(), '.herdr/worktrees'));
});

test('rejects an invalid config with the offending field named', async (t) => {
	await assert.rejects(
		load(t, JSON.stringify({ pollSeconds: 2, teams: { Unbound: { repo: '~/unbound' } } })),
		/invalid config .*config\.json:[\s\S]*pollSeconds/,
	);
	await assert.rejects(load(t, JSON.stringify({ staleAfterSeconds: 10, teams: { Unbound: { repo: '~/unbound' } } })), /staleAfterSeconds/);
	await assert.rejects(load(t, JSON.stringify({ teams: {} })), /no teams configured/);
	await assert.rejects(load(t, JSON.stringify({ teams: { Unbound: { repo: '~/unbound', repos: '~/x' } } })), /repos/);
	await assert.rejects(load(t, JSON.stringify({ teams: { Unbound: { repo: '~/unbound' } }, maxInflight: 2 })), /maxInflight/);
	await assert.rejects(load(t, '{ "teams": '), SyntaxError);
});

const config = configSchema.parse({
	teams: {
		Unbound: { repo: '/home/dev/unbound', labelReposDirectory: '/home/dev/unbound-app' },
		Hivemind: { repo: '/home/dev/hivemind.ts' },
	},
});

test('resolves a team to its repo unless a repo label points elsewhere', () => {
	assert.deepEqual(resolveRepo(config, 'Unbound', [{ name: 'bug', parent: null }]), { ok: true, path: '/home/dev/unbound' });
	assert.deepEqual(resolveRepo(config, 'Unbound', [{ name: 'repo:loader-ios', parent: null }]), {
		ok: true,
		path: '/home/dev/unbound-app/loader-ios',
	});
	assert.deepEqual(resolveRepo(config, 'Unbound', [{ name: 'loader-ios', parent: { name: 'repo' } }]), {
		ok: true,
		path: '/home/dev/unbound-app/loader-ios',
	});
	assert.deepEqual(resolveRepo(config, 'Hivemind', []), { ok: true, path: '/home/dev/hivemind.ts' });
});

test('refuses repo labels it cannot resolve safely', () => {
	const failure = (team: string, names: string[]) => {
		const result = resolveRepo(
			config,
			team,
			names.map((name) => ({ name, parent: null })),
		);

		return result.ok ? undefined : result.error;
	};

	assert.match(failure('Unbound', ['repo:web', 'repo:vbound'])!, /more than one repo label/);
	assert.match(failure('Unbound', ['repo:../../etc'])!, /not a valid repo name/);
	assert.match(failure('Hivemind', ['repo:web'])!, /team Hivemind has no labelReposDirectory/);
	assert.match(failure('Telecord', [])!, /team Telecord has no repo in the config/);
});
