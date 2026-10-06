import { Context, type Effect, Schema, type Stream } from 'effect';
import type { CallError } from './call-policy.ts';

// The chat platform's handle on one message, which an answer to it carries back. Only the platform reads it.
export const MessageRef = Schema.String;

// Where a message was written. The main chat is the platform's general conversation with the bot.
export const Conversation = Schema.Union([Schema.TaggedStruct('main', {})]);

export type Conversation = typeof Conversation.Type;

// A message from an allowed user, as core sees it whatever the platform.
export const InboundMessage = Schema.Struct({
	ref: MessageRef,
	conversation: Conversation,
	text: Schema.String,
	// The message it replies to, if it is a reply.
	replyTo: Schema.NullOr(MessageRef),
});

export type InboundMessage = typeof InboundMessage.Type;

// What core asks the platform to show; the platform decides how it looks.
export const Intent = Schema.Union([Schema.TaggedStruct('reply', { to: MessageRef, text: Schema.String })]);

export type Intent = typeof Intent.Type;

// The chat platform, as core uses it. The live layer is Telegram's (`telegram.ts`).
export class Chat extends Context.Service<
	Chat,
	{
		// Messages from allowed users, oldest first, those sent while the service was down included. Messages from anyone
		// else are dropped and logged. One consumer only.
		readonly inbound: Stream.Stream<InboundMessage>;
		readonly send: (intent: Intent) => Effect.Effect<void, CallError>;
	}
>()('sapphire-agent/Chat') {}
