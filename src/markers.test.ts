import { assert, describe, it } from '@effect/vitest';
import { Option } from 'effect';
import { ON_BEHALF_OF_CLAUDE } from './github.ts';
import { hasMarker, type Marker, parseMarker, renderMarker, withMarker } from './markers.ts';

describe('markers', () => {
	it('renders a hidden comment naming the epic, purpose and key', () => {
		assert.strictEqual(
			renderMarker({ identifier: 'UNB-12', purpose: 'awaitingInput', key: '1791000000000-1791001800000' }),
			'<!-- herdr-linear:UNB-12:awaitingInput:1791000000000-1791001800000 -->',
		);
	});

	it('reads back a key holding a path, from a PR comment that ends with the onBehalfOf block', () => {
		const marker: Marker = { identifier: 'UNB-12', purpose: 'keptWorktree', key: '/home/dev/.herdr/worktrees/unbound/my work:tree' };
		const body = `${withMarker('**herdr-linear:** kept the worktree.', marker).body}\n\n${ON_BEHALF_OF_CLAUDE}`;

		assert.deepStrictEqual(parseMarker(body), Option.some(marker));
		assert.isTrue(hasMarker(body, marker));
		assert.isFalse(hasMarker(body, { ...marker, key: '/home/dev/.herdr/worktrees/unbound/other' }));
	});

	it('ignores a marker the user quoted in their reply', () => {
		const reply = '> **herdr-linear** (`awaitingInput`): the agent has been idle for 4 min\n> <!-- herdr-linear:UNB-12:awaitingInput:1-2 -->\n\nUse the remote settings.';

		assert.deepStrictEqual(parseMarker(reply), Option.none());
	});

	it('ignores plain text and unknown purposes', () => {
		assert.deepStrictEqual(parseMarker('Use the remote settings.'), Option.none());
		assert.deepStrictEqual(parseMarker('<!-- herdr-linear:UNB-12:celebrate:1 -->'), Option.none());
	});
});
