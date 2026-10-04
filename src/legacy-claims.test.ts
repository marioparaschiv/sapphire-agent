import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { onTestFinished } from 'vitest';
import { AppConfig } from './config.ts';
import { refuseUndrainedClaims } from './legacy-claims.ts';

const stateDirectory = () => {
	const dir = mkdtempSync(join(tmpdir(), 'herdr-linear-claims-'));

	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

	return dir;
};

const check = (dir: string) => refuseUndrainedClaims.pipe(Effect.provide(Layer.merge(AppConfig.layerTest(dir), NodeServices.layer)));

// As the old dispatcher writes it.
const oldClaim = {
	epicId: 'b1c2d3',
	identifier: 'UNB-12',
	teamId: 'team-unbound',
	status: 'running',
	claimedAt: 1_791_000_000_000,
	job: { epicId: 'b1c2d3', identifier: 'UNB-12', branch: 'mario/unb-12-settings-sync', repoPath: '/home/dev/unbound', tabLabel: 'UNB-12 Settings sync', prompt: '/orchestrate ...' },
};

describe('refuseUndrainedClaims', () => {
	it.effect('refuses to start while claims.json holds claims, saying to drain first', () =>
		Effect.gen(function* () {
			const dir = stateDirectory();

			writeFileSync(join(dir, 'claims.json'), `${JSON.stringify({ claims: [oldClaim] }, null, '\t')}\n`);

			const error = yield* Effect.flip(check(dir));

			assert.strictEqual(
				error.message,
				`cannot start, fix these and restart:\n- ${join(dir, 'claims.json')} still holds 1 claim of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete ${join(dir, 'claims.json')}.`,
			);
		}),
	);

	it.effect('starts with an empty claims.json or none at all', () =>
		Effect.gen(function* () {
			const dir = stateDirectory();

			yield* check(dir);
			writeFileSync(join(dir, 'claims.json'), '{\n\t"claims": []\n}\n');
			yield* check(dir);
		}),
	);

	it.effect('refuses a claims.json it cannot read', () =>
		Effect.gen(function* () {
			const dir = stateDirectory();

			writeFileSync(join(dir, 'claims.json'), '{"claims": ');

			const error = yield* Effect.flip(check(dir));

			assert.match(error.message, /claims\.json is not a claims file/);
		}),
	);
});
