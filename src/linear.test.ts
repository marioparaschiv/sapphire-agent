import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Linear } from './linear.ts';
import { LinearFixture, otherTeam, testTeam } from './linear-fixture.ts';
import { renderMarker, withMarker } from './markers.ts';

const withFixture = Effect.provide(LinearFixture.layer.pipe(Layer.provide(AppConfig.layerTest('/tmp/sapphire-agent-test'))));

const stateId = (name: string) => testTeam.states.nodes.find((state) => state.name === name)?.id ?? '';

const pullRequestOpened = withMarker('PR opened: https://github.com/test/repo/pull/1', {
	identifier: 'TEST-10',
	purpose: 'pullRequestOpened',
	key: 'https://github.com/test/repo/pull/1',
});

describe('Linear reads', () => {
	it.effect('decodes teams with their workflow states', () =>
		Effect.gen(function* () {
			const linear = yield* Linear;
			const teams = yield* linear.teams(['Test', 'Unknown']);

			assert.deepStrictEqual(
				teams.map((team) => [team.name, team.key, team.states.nodes.map((state) => `${state.name}:${state.type}`)]),
				[
					[
						'Test',
						'TEST',
						['To Do:unstarted', 'Ready For Agent:unstarted', 'Implementing:started', 'In Review:started', 'To Review:started', 'Shipped:completed', 'Done:completed', 'Canceled:canceled'],
					],
				],
			);
			assert.deepStrictEqual([...(yield* LinearFixture).authorizations], ['lin_api_test']);
		}).pipe(withFixture),
	);

	it.effect('reads ready top-level epics with labels, sub-issue presence and the issues related to them in any team, and epics by id wherever they are', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const repoLabel = fixture.addLabel({ name: 'loader-ios', parentName: 'repo' });
			const blocker = fixture.addEpic({ identifier: 'OPS-3', title: 'Rotate the API keys', teamId: otherTeam.id, state: 'In Progress', subIssues: 0 });
			const related = fixture.addEpic({ identifier: 'TEST-9', title: 'Old HTTP client', state: 'Done', subIssues: 0 });
			const withSlices = fixture.addEpic({
				identifier: 'TEST-10',
				title: 'Linear service on HttpClient',
				labelIds: [repoLabel.id],
				inverseRelations: [
					{ type: 'blocks', issueId: blocker.id },
					{ type: 'related', issueId: related.id },
				],
			});
			const withoutSlices = fixture.addEpic({ identifier: 'TEST-11', title: 'Lonely epic', subIssues: 0 });
			const implementing = fixture.addEpic({ identifier: 'TEST-12', title: 'Already running', state: 'Implementing' });

			const ready = yield* linear.readyEpics([stateId('Ready For Agent')]);

			assert.deepStrictEqual(
				ready.map((epic) => [epic.identifier, epic.state.name, epic.labels.nodes, epic.children.nodes.length > 0]),
				[
					['TEST-10', 'Ready For Agent', [{ id: repoLabel.id, name: 'loader-ios', parent: { name: 'repo' } }], true],
					['TEST-11', 'Ready For Agent', [], false],
				],
			);
			assert.deepStrictEqual(ready[0], {
				id: withSlices.id,
				identifier: 'TEST-10',
				title: 'Linear service on HttpClient',
				url: 'https://linear.app/marioparaschiv/issue/TEST-10/linear-service-on-httpclient',
				branchName: 'mario/test-10-linear-service-on-httpclient',
				sortOrder: 2,
				createdAt: '1969-12-31T00:00:00.000Z',
				team: { id: testTeam.id, name: 'Test' },
				state: { id: stateId('Ready For Agent'), name: 'Ready For Agent' },
				labels: { nodes: [{ id: repoLabel.id, name: 'loader-ios', parent: { name: 'repo' } }] },
				parent: null,
				children: { nodes: [{ id: fixture.subIssues(withSlices.id)[0].id }] },
				inverseRelations: {
					nodes: [
						{ type: 'blocks', issue: { identifier: 'OPS-3', state: { type: 'started' } } },
						{ type: 'related', issue: { identifier: 'TEST-9', state: { type: 'completed' } } },
					],
				},
			});

			yield* linear.moveIssue(withSlices.id, stateId('Implementing'));

			const claimed = yield* linear.epics([withSlices.id, implementing.id, withoutSlices.id]);

			assert.deepStrictEqual(
				claimed.map((epic) => [epic.identifier, epic.state.name]),
				[
					['TEST-10', 'Implementing'],
					['TEST-11', 'Ready For Agent'],
					['TEST-12', 'Implementing'],
				],
			);
			assert.deepStrictEqual(fixture.mutations, [`move ${withSlices.id} ${stateId('Implementing')}`]);
		}).pipe(withFixture),
	);

	it.effect('reads issues by identifier with their parent, skipping identifiers no issue has', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;

			fixture.addEpic({ identifier: 'TEST-10', title: 'Shipped one', state: 'Shipped' });
			fixture.addEpic({ identifier: 'TEST-11', title: 'Not asked for' });
			fixture.addEpic({ identifier: 'TEST-12', title: 'Running', state: 'Implementing' });

			const epics = yield* linear.epicsByIdentifier(['TEST-12', 'TEST-10', 'TEST-99', 'TEST-101']);

			assert.deepStrictEqual(
				epics.map((epic) => [epic.identifier, epic.state.name, epic.parent]),
				[
					['TEST-10', 'Shipped', null],
					['TEST-101', 'To Do', { identifier: 'TEST-10' }],
					['TEST-12', 'Implementing', null],
				],
			);
		}).pipe(withFixture),
	);

	it.effect('refuses to read more epics than one page holds', () =>
		Effect.gen(function* () {
			const linear = yield* Linear;
			const ids = Array.from({ length: 251 }, (_, index) => `issue-test-${index}`);
			const error = yield* Effect.flip(linear.epics(ids));

			assert.instanceOf(error, Permanent);
			assert.strictEqual(error.message, '251 epics exceed the 250 issues one read can return');
		}).pipe(withFixture),
	);
});

describe('Linear writes', () => {
	it.effect('posts a marked comment once, even when asked twice', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			yield* linear.comment(epic.id, pullRequestOpened);
			yield* linear.comment(epic.id, pullRequestOpened);

			assert.deepStrictEqual(
				fixture.comments(epic.id).map((comment) => comment.body),
				[`PR opened: https://github.com/test/repo/pull/1\n\n${renderMarker(pullRequestOpened.marker)}`],
			);
			assert.deepStrictEqual(fixture.mutations, [`comment ${epic.id}`]);
		}).pipe(withFixture),
	);

	it.effect('finds the marker on a later page of comments', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			for (let index = 0; index < 260; index += 1) {
				fixture.addComment(epic.id, `Progress note ${index}`);
			}

			fixture.addComment(epic.id, pullRequestOpened.body);
			yield* linear.comment(epic.id, pullRequestOpened);

			assert.strictEqual(fixture.comments(epic.id).length, 261);
			assert.deepStrictEqual(fixture.mutations, []);
		}).pipe(withFixture),
	);

	it.effect('does not post twice when the connection drops after the post was applied', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.crashAfterWrite(1);

			const fiber = yield* linear.comment(epic.id, pullRequestOpened).pipe(Effect.forkChild);

			// The marker read, then the post whose answer is lost.
			yield* fixture.awaitAnswers(2);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
			yield* TestClock.adjust('2 seconds');

			yield* Fiber.join(fiber);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
			assert.deepStrictEqual(fixture.mutations, [`comment ${epic.id}`]);

			// A fresh process asking again finds the same comment.
			yield* linear.comment(epic.id, pullRequestOpened);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
		}).pipe(withFixture),
	);

	it.effect('waits for Retry-After before retrying a rate-limited write', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.failWrite(1, 429, 30);

			const fiber = yield* linear.comment(epic.id, pullRequestOpened).pipe(Effect.forkChild);

			yield* fixture.awaitAnswers(2);
			yield* TestClock.adjust('29999 millis');
			assert.deepStrictEqual(fixture.comments(epic.id), []);
			yield* TestClock.adjust('1 millis');

			yield* Fiber.join(fiber);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
		}).pipe(withFixture),
	);

	it.effect('treats a RATELIMITED error on HTTP 400 as a rate limit, not a rejection', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.rateLimitWrite(1, 30);

			const fiber = yield* linear.comment(epic.id, pullRequestOpened).pipe(Effect.forkChild);

			yield* fixture.awaitAnswers(2);
			yield* TestClock.adjust('30 seconds');

			yield* Fiber.join(fiber);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
		}).pipe(withFixture),
	);

	it.effect('fails a rejected write at once as Permanent', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.failWrite(1, 400);

			const error = yield* Effect.flip(linear.comment(epic.id, pullRequestOpened));

			assert.instanceOf(error, Permanent);
			assert.strictEqual(error.message, 'Linear answered HTTP 400: injected failure of write 1');
			assert.deepStrictEqual(fixture.comments(epic.id), []);
		}).pipe(withFixture),
	);

	it.effect('adds the workspace label over the team label, creates a missing team label once, and removes labels', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			fixture.addLabel({ name: 'needs-design', teamId: testTeam.id });
			const workspaceLabel = fixture.addLabel({ name: 'needs-design' });
			const first = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });
			const second = fixture.addEpic({ identifier: 'TEST-11', title: 'GitHub service' });

			yield* linear.addLabel(first.id, testTeam.id, 'needs-design');
			yield* linear.addLabel(first.id, testTeam.id, 'agent-stuck');
			yield* linear.addLabel(second.id, testTeam.id, 'agent-stuck');

			assert.deepStrictEqual(fixture.labelNames(first.id), ['needs-design', 'agent-stuck']);
			assert.deepStrictEqual(fixture.issue(first.id).labelIds.slice(0, 1), [workspaceLabel.id]);

			const stuckId = fixture.issue(second.id).labelIds[0];

			yield* linear.removeLabel(first.id, stuckId);

			assert.deepStrictEqual(fixture.labelNames(first.id), ['needs-design']);
			assert.deepStrictEqual(fixture.mutations, [
				`add-label ${first.id} ${workspaceLabel.id}`,
				'create-label agent-stuck',
				`add-label ${first.id} ${stuckId}`,
				`add-label ${second.id} ${stuckId}`,
				`remove-label ${first.id} ${stuckId}`,
			]);
		}).pipe(withFixture),
	);
});
