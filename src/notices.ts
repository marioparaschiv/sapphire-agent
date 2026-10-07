import { Effect, Option } from 'effect';
import { Journal, type UnsentNotice } from './journal.ts';
import { Linear } from './linear.ts';
import { withMarker } from './markers.ts';
import { epicWithIdentifier, type Observation } from './observation.ts';
import type { Rule } from './planner.ts';

// Posts the notices in the journal's outbox, oldest first, each as a comment on its epic ending with its marker, then
// marks it sent. Linear.comment skips a notice whose marker the epic has already, so a crash in between never posts it
// twice. A notice Linear refuses is tried again next tick, while Linear being down stops the rest until then. Runs
// last, so what every rule wrote this tick is posted in it. Not pausable.
export const noticesRule = Effect.gen(function* () {
	const journal = yield* Journal;
	const linear = yield* Linear;

	const post = (observation: Observation, notices: ReadonlyArray<UnsentNotice>) =>
		Effect.gen(function* () {
			const unobserved = [...new Set(notices.map(({ identifier }) => identifier))].filter((identifier) => Option.isNone(epicWithIdentifier(observation, identifier)));
			const others = yield* linear.epicsByIdentifier(unobserved);

			for (const { id, text, ...marker } of notices) {
				const epic = Option.orElse(epicWithIdentifier(observation, marker.identifier), () => Option.fromUndefinedOr(others.find((other) => other.identifier === marker.identifier)));
				const key = `${marker.identifier}:${marker.purpose}:${marker.key}`;

				if (Option.isNone(epic)) {
					yield* Effect.logError(`there is no epic ${marker.identifier} in Linear; dropping notice ${key}`);
					yield* journal.markNoticeSent(id);
					continue;
				}

				yield* linear.comment(epic.value.id, withMarker(text, marker)).pipe(
					Effect.andThen(journal.markNoticeSent(id)),
					Effect.catchTag('Permanent', (error) => Effect.logError(`cannot post notice ${key}; trying again next tick`, error)),
				);
			}
		});

	const plan = (observation: Observation) =>
		journal.unsentNotices.pipe(Effect.map((notices) => (notices.length === 0 ? [] : [{ task: 'notices', apply: post(observation, notices) }])));

	return { name: 'notices', pausable: false, plan } satisfies Rule;
});
