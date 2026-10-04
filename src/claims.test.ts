import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaimStore } from './claims.ts';

test('loads claims written with the old stuck and failed statuses', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-claims-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'claims.json');
	const claim = (epicId: string, status: string) => ({ epicId, identifier: epicId, teamId: 'team', status, claimedAt: 0 });
	writeFileSync(path, JSON.stringify({ claims: [claim('UNB-1', 'stuck'), claim('UNB-2', 'failed'), claim('UNB-3', 'running')] }));

	const claims = await ClaimStore.open(path);

	assert.deepEqual(
		claims.all().map((loaded) => loaded.status),
		['awaitingInput', 'error', 'running'],
	);
	writeFileSync(path, JSON.stringify({ claims: [claim('UNB-4', 'paused')] }));
	await assert.rejects(ClaimStore.open(path), /status/);
});
