import { Effect, Schedule, Stream } from 'effect';
import { Chat, type InboundMessage } from './chat.ts';

export const acknowledgement = 'Got it.';

// Once the call policy's own retries are used up, a Transient failure to answer waits this long before the next try,
// and later messages wait behind it so they are answered in order.
const answerRetry = Schedule.spaced('30 seconds');

// Core's side of the chat: answers each message from an allowed user, until interrupted. A message that cannot be
// answered for good (Permanent) is logged and dropped.
export const answerChatMessages = Effect.gen(function* () {
	const chat = yield* Chat;

	const answer = (message: InboundMessage) =>
		chat.send({ _tag: 'reply', to: message.ref, text: acknowledgement }).pipe(
			Effect.tapError((error) => (error._tag === 'Transient' ? Effect.logWarning('cannot answer a chat message yet; trying again', error) : Effect.void)),
			Effect.retry({ schedule: answerRetry, while: (error) => error._tag === 'Transient' }),
			Effect.catch((error) => Effect.logError('cannot answer a chat message; dropping it', error)),
		);

	return yield* Stream.runForEach(chat.inbound, answer);
});
