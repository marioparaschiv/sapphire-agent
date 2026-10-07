import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { type CallError, callTimeouts, Permanent, Transient, transportFailure, withWritePolicy } from './call-policy.ts';
import { PushoverConfig } from './config.ts';

// high: the notice is about something that stops dispatch.
const pushoverPriorities = { high: 1, normal: 0 } as const;

export type PushoverMessage = {
	readonly title: string;
	readonly message: string;
	readonly url?: string;
	readonly priority: keyof typeof pushoverPriorities;
};

const ErrorBody = Schema.fromJsonString(Schema.Struct({ errors: Schema.Array(Schema.String) }));

// The phone notifications the service sends about itself, as opposed to one epic.
export class Pushover extends Context.Service<
	Pushover,
	{
		readonly send: (message: PushoverMessage) => Effect.Effect<void, CallError>;
	}
>()('sapphire-agent/Pushover') {
	static readonly layer = (endpoint = 'https://api.pushover.net/1/messages.json') =>
		Layer.effect(
			Pushover,
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const { appToken, userKey } = yield* PushoverConfig;

				const send = ({ title, message, url, priority }: PushoverMessage) =>
					Effect.gen(function* () {
						const response = yield* HttpClientRequest.post(endpoint).pipe(
							HttpClientRequest.bodyUrlParams({
								token: Redacted.value(appToken),
								user: Redacted.value(userKey),
								title,
								message,
								priority: String(pushoverPriorities[priority]),
								...(url === undefined ? {} : { url }),
							}),
							client.execute,
							Effect.mapError(transportFailure('Pushover')),
						);
						const { status } = response;

						if (status >= 200 && status < 300) {
							return;
						}

						if (status >= 500) {
							return yield* new Transient({ message: `Pushover answered HTTP ${status}` });
						}

						const errors = yield* response.text.pipe(
							Effect.flatMap(Schema.decodeEffect(ErrorBody)),
							Effect.map(({ errors }) => errors.join('; ')),
							Effect.orElseSucceed(() => 'no error message'),
						);

						return yield* new Permanent({ message: `Pushover answered HTTP ${status}: ${errors}` });
					}).pipe(withWritePolicy(callTimeouts.pushover));

				return Pushover.of({ send });
			}),
		);
}

// For a notice that is not all the user hears of something, e.g. beside a flag on the epic: a failed send is only logged.
export const sendOrLog = (pushover: Pushover['Service'], message: PushoverMessage) =>
	pushover.send(message).pipe(Effect.catch((error) => Effect.logWarning(`cannot send "${message.title}" to Pushover`, error)));
