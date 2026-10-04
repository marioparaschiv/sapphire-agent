import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { Permanent } from './call-policy.ts';
import { AppConfig } from './config.ts';
import { Linear } from './linear.ts';
import { LinearFixture, testTeam } from './linear-fixture.ts';
import { renderMarker, withMarker } from './markers.ts';

const withFixture = Effect.provide(LinearFixture.layer.pipe(Layer.provide(AppConfig.layerTest('/tmp/herdr-linear-test'))));

const stateId = (name: string) => testTeam.states.nodes.find((state) => state.name === name)?.id ?? '';

const errorFlag = withMarker('The agent exited before opening a PR. Check the tab for details.', {
	identifier: 'TEST-10',
	purpose: 'error',
	key: '1790000000000',
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
						['To Do:unstarted', 'Ready For Agent:unstarted', 'Implementing:started', 'In Review:started', 'To Review:started', 'Shipped:completed', 'Done:completed'],
					],
				],
			);
			assert.deepStrictEqual([...(yield* LinearFixture).authorizations], ['lin_api_test']);
		}).pipe(withFixture),
	);

	it.effect('reads ready top-level epics with labels and sub-issue presence, and epics by id wherever they are', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const repoLabel = fixture.addLabel({ name: 'loader-ios', parentName: 'repo' });
			const withSlices = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient', labelIds: [repoLabel.id] });
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
				sortOrder: 0,
				team: { id: testTeam.id, name: 'Test' },
				state: { id: stateId('Ready For Agent'), name: 'Ready For Agent' },
				labels: { nodes: [{ id: repoLabel.id, name: 'loader-ios', parent: { name: 'repo' } }] },
				children: { nodes: [{ id: fixture.subIssues(withSlices.id)[0].id }] },
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

	it.effect('refuses to read more epics than one page holds', () =>
		Effect.gen(function* () {
			const linear = yield* Linear;
			const ids = Array.from({ length: 251 }, (_, index) => `issue-test-${index}`);
			const error = yield* Effect.flip(linear.epics(ids));

			assert.instanceOf(error, Permanent);
			assert.strictEqual(error.message, '251 epics exceed the 250 issues one read can return');
		}).pipe(withFixture),
	);

	it.effect('reads the replies to question comments and every comment on an issue across pages', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });
			const question = fixture.addComment(epic.id, 'The agent is waiting for input:\n\n```\nWhich endpoint should I use?\n```');
			const answer = fixture.addComment(epic.id, 'Use the GraphQL endpoint.', {
				parentId: question.id,
				createdAt: '2026-10-01T09:30:00.000Z',
				reactions: ['white_check_mark'],
			});
			const other = fixture.addEpic({ identifier: 'TEST-11', title: 'Other epic' });

			fixture.addComment(other.id, 'Unrelated');

			for (let index = 0; index < 260; index += 1) {
				fixture.addComment(epic.id, `Progress note ${index}`);
			}

			const replies = yield* linear.replies([question.id]);

			assert.deepStrictEqual(replies, [
				{ id: answer.id, body: 'Use the GraphQL endpoint.', createdAt: '2026-10-01T09:30:00.000Z', parent: { id: question.id }, reactions: [{ emoji: 'white_check_mark' }] },
			]);

			const comments = yield* linear.comments(epic.id);

			assert.strictEqual(comments.length, 262);
			assert.deepStrictEqual(comments[1], replies[0]);
			assert.strictEqual(comments[0].parent, null);
			assert.strictEqual(comments.at(-1)?.body, 'Progress note 259');
		}).pipe(withFixture),
	);
});

describe('Linear writes', () => {
	it.effect('posts a marked comment once, even when asked twice or as a reply', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });
			const first = yield* linear.comment(epic.id, errorFlag);
			const second = yield* linear.comment(epic.id, errorFlag);

			assert.strictEqual(second, first);
			assert.deepStrictEqual(
				fixture.comments(epic.id).map((comment) => comment.body),
				[`The agent exited before opening a PR. Check the tab for details.\n\n${renderMarker(errorFlag.marker)}`],
			);

			const question = fixture.addComment(epic.id, 'The agent is waiting for input.');
			const reply = fixture.addComment(epic.id, 'Go ahead.', { parentId: question.id });
			const replyFailed = withMarker('Could not type this reply into the pane.', { identifier: 'TEST-10', purpose: 'replyFailed', key: reply.id });
			const notice = yield* linear.comment(epic.id, replyFailed, question.id);

			assert.strictEqual(yield* linear.comment(epic.id, replyFailed, question.id), notice);
			assert.deepStrictEqual(fixture.mutations, [`comment ${epic.id}`, `comment ${epic.id} in ${question.id}`]);
		}).pipe(withFixture),
	);

	it.effect('does not post twice when the connection drops after the post was applied', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.crashAfterWrite(1);

			const fiber = yield* linear.comment(epic.id, errorFlag).pipe(Effect.forkChild);

			// The marker read, then the post whose answer is lost.
			yield* fixture.awaitAnswers(2);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
			yield* TestClock.adjust('2 seconds');

			const id = yield* Fiber.join(fiber);

			assert.deepStrictEqual(
				fixture.comments(epic.id).map((comment) => comment.id),
				[id],
			);
			assert.deepStrictEqual(fixture.mutations, [`comment ${epic.id}`]);

			// A fresh process asking again finds the same comment.
			assert.strictEqual(yield* linear.comment(epic.id, errorFlag), id);
			assert.strictEqual(fixture.comments(epic.id).length, 1);
		}).pipe(withFixture),
	);

	it.effect('waits for Retry-After before retrying a rate-limited write', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.failWrite(1, 429, 30);

			const fiber = yield* linear.comment(epic.id, errorFlag).pipe(Effect.forkChild);

			yield* fixture.awaitAnswers(2);
			yield* TestClock.adjust('29999 millis');
			assert.deepStrictEqual(fixture.comments(epic.id), []);
			yield* TestClock.adjust('1 millis');

			const id = yield* Fiber.join(fiber);

			assert.deepStrictEqual(
				fixture.comments(epic.id).map((comment) => comment.id),
				[id],
			);
		}).pipe(withFixture),
	);

	it.effect('treats a RATELIMITED error on HTTP 400 as a rate limit, not a rejection', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.rateLimitWrite(1, 30);

			const fiber = yield* linear.comment(epic.id, errorFlag).pipe(Effect.forkChild);

			yield* fixture.awaitAnswers(2);
			yield* TestClock.adjust('30 seconds');

			const id = yield* Fiber.join(fiber);

			assert.deepStrictEqual(
				fixture.comments(epic.id).map((comment) => comment.id),
				[id],
			);
		}).pipe(withFixture),
	);

	it.effect('fails a rejected write at once as Permanent', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });

			fixture.failWrite(1, 400);

			const error = yield* Effect.flip(linear.comment(epic.id, errorFlag));

			assert.instanceOf(error, Permanent);
			assert.strictEqual(error.message, 'Linear answered HTTP 400: injected failure of write 1');
			assert.deepStrictEqual(fixture.comments(epic.id), []);
		}).pipe(withFixture),
	);

	it.effect('reacts once per emoji', () =>
		Effect.gen(function* () {
			const fixture = yield* LinearFixture;
			const linear = yield* Linear;
			const epic = fixture.addEpic({ identifier: 'TEST-10', title: 'Linear service on HttpClient' });
			const question = fixture.addComment(epic.id, 'The agent is waiting for input.');
			const reply = fixture.addComment(epic.id, 'Use the fixture.', { parentId: question.id });

			yield* linear.react(reply.id, 'white_check_mark');
			yield* linear.react(reply.id, 'white_check_mark');

			assert.deepStrictEqual(fixture.comments(epic.id)[1].reactions, ['white_check_mark']);
			assert.deepStrictEqual(fixture.mutations, [`react ${reply.id} white_check_mark`]);
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
