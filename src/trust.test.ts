import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trustFolder } from './trust.ts';

test('pre-accepts the trust dialog for a folder, keeping everything else and a backup', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-trust-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, '.claude.json');
	const original = {
		numStartups: 412,
		mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
		projects: {
			'/home/dev': { allowedTools: [], hasTrustDialogAccepted: false, lastCost: 0.17 },
			'/home/dev/.herdr/worktrees/unbound/mario-unb-12': { lastSessionId: 'd483ae2a' },
		},
	};
	writeFileSync(path, JSON.stringify(original, null, 2), { mode: 0o600 });

	await trustFolder(path, '/home/dev/.herdr/worktrees/unbound/mario-unb-12');
	await trustFolder(path, '/home/dev/.herdr/worktrees/telecord/mario-tel-3');

	const updated = JSON.parse(readFileSync(path, 'utf8'));
	assert.deepEqual(updated, {
		...original,
		projects: {
			...original.projects,
			'/home/dev/.herdr/worktrees/unbound/mario-unb-12': { lastSessionId: 'd483ae2a', hasTrustDialogAccepted: true },
			'/home/dev/.herdr/worktrees/telecord/mario-tel-3': { hasTrustDialogAccepted: true },
		},
	});
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(`${path}.herdr-linear.bak`, 'utf8')).projects), [
		'/home/dev',
		'/home/dev/.herdr/worktrees/unbound/mario-unb-12',
	]);
});

test('fails loudly on a config that is not JSON instead of overwriting it', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-trust-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, '.claude.json');
	writeFileSync(path, '{"projects": {');

	await assert.rejects(trustFolder(path, '/tmp/x'), SyntaxError);
	assert.equal(readFileSync(path, 'utf8'), '{"projects": {');
});
