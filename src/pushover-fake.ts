import { Context, Effect, Layer } from 'effect';
import { Permanent } from './call-policy.ts';
import { Pushover, type PushoverMessage } from './pushover.ts';

export type FakePushoverControls = {
	// What reached Pushover, oldest first.
	readonly sent: () => ReadonlyArray<PushoverMessage>;
	// Fails the next `times` sends with a Permanent error, as Pushover does for an invalid token.
	readonly failNext: (times: number) => void;
};

export class FakePushover extends Context.Service<FakePushover, FakePushoverControls>()('sapphire-agent/FakePushover') {
	static readonly layer = Layer.effectContext(
		Effect.sync(() => {
			const sent: Array<PushoverMessage> = [];
			let failures = 0;

			const send = (message: PushoverMessage) =>
				Effect.suspend(() => {
					if (failures > 0) {
						failures -= 1;

						return Effect.fail(new Permanent({ message: 'Pushover answered HTTP 400: application token is invalid' }));
					}

					sent.push(message);

					return Effect.void;
				});

			const controls: FakePushoverControls = {
				sent: () => [...sent],
				failNext: (times) => {
					failures = times;
				},
			};

			return Context.make(Pushover, Pushover.of({ send })).pipe(Context.add(FakePushover, controls));
		}),
	);
}
