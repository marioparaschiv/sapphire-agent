import { assert, describe, it } from '@effect/vitest';
import { Schema } from 'effect';
import { recordedInit } from './claude-chat-fake.ts';
import { type ClaudeSettings, InitEvent, modelMatches, settingsMismatches } from './claude-settings.ts';

const init = Schema.decodeUnknownSync(InitEvent)(recordedInit);

// ~/.claude/settings.json's checked keys, as they were when the init event was recorded.
const settings: ClaudeSettings = {
	model: 'opus[1m]',
	outputStyle: 'ADHD',
	permissions: { defaultMode: 'bypassPermissions' },
	enabledPlugins: { 'frontend-design@claude-plugins-official': true, 'superpowers@claude-plugins-official': false, 'virtuoso-skills@virtuoso': true },
};

describe('settingsMismatches', () => {
	it('finds none between the recorded init event and the settings it was recorded with', () => {
		assert.deepStrictEqual(settingsMismatches(settings, ['tailnet', 'linear'], init), []);
	});

	it('names each key the init event does not run with', () => {
		assert.deepStrictEqual(
			settingsMismatches(
				{
					model: 'sonnet',
					outputStyle: 'Explanatory',
					permissions: { defaultMode: 'acceptEdits' },
					enabledPlugins: { 'frontend-design@claude-plugins-official': false, 'superpowers@claude-plugins-official': true, 'virtuoso-skills@virtuoso': true },
				},
				['tailnet', 'github'],
				init,
			),
			[
				{ key: 'model', configured: 'sonnet', reported: 'claude-opus-5-5[1m]' },
				{ key: 'outputStyle', configured: 'Explanatory', reported: 'ADHD' },
				{ key: 'permissions.defaultMode', configured: 'acceptEdits', reported: 'bypassPermissions' },
				{ key: 'enabledPlugins.frontend-design@claude-plugins-official', configured: 'disabled', reported: 'loaded' },
				{ key: 'enabledPlugins.superpowers@claude-plugins-official', configured: 'enabled', reported: 'not loaded' },
				{ key: 'mcpServers.github', configured: 'configured', reported: 'missing' },
			],
		);
	});

	it('leaves out the keys settings.json does not set', () => {
		assert.deepStrictEqual(settingsMismatches({}, [], { ...init, output_style: 'default', permissionMode: 'default' }), []);
	});
});

describe('modelMatches', () => {
	it('matches an alias with the model it resolves to, and the context window too', () => {
		assert.isTrue(modelMatches('opus[1m]', 'claude-opus-5-5[1m]'));
		assert.isTrue(modelMatches('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'));
		assert.isFalse(modelMatches('opus', 'claude-opus-5-5[1m]'));
		assert.isFalse(modelMatches('sonnet[1m]', 'claude-opus-5-5[1m]'));
	});
});
