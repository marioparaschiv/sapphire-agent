import { Context, type Effect, Schema, type Stream } from 'effect';
import type { CallError } from './call-policy.ts';

// The chat platform's handle on one message, which an answer to it carries back. Only the platform reads it.
export const MessageRef = Schema.String;

export type MessageRef = typeof MessageRef.Type;

// The platform's handle on a conversation it opened for core, e.g. an epic's forum topic. Only the platform reads it.
export const ThreadRef = Schema.String;

export type ThreadRef = typeof ThreadRef.Type;

// Where a message was written. The main chat is the platform's general conversation with the bot; a thread is one the
// platform opened for core (`openEpic`), which core knows by its ref.
export const Conversation = Schema.Union([Schema.TaggedStruct('main', {}), Schema.TaggedStruct('thread', { thread: ThreadRef })]);

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

// What an epic's thread shows of its run. review: no run in flight and the epic waits for review.
export const EpicState = Schema.Literals(['working', 'awaitingInput', 'error', 'review']);

export type EpicState = typeof EpicState.Type;

export const EpicHeading = Schema.Struct({ identifier: Schema.String, title: Schema.String });

export type EpicHeading = typeof EpicHeading.Type;

// The phases of a run its thread shows as they start, named by the skill the agent runs for each.
export const Phase = Schema.Literals(['sreview', 'review-verify', 'pr']);

export type Phase = typeof Phase.Type;

export const SliceProgress = Schema.Literals(['started', 'done']);

export type SliceProgress = typeof SliceProgress.Type;

// What core asks the platform to show; the platform decides how it looks. Every intent but `reply` may be sent again
// after a crash, so the platform shows each once.
export const Intent = Schema.Union([
	Schema.TaggedStruct('reply', { to: MessageRef, text: Schema.String }),
	Schema.TaggedStruct('epicState', { thread: ThreadRef, epic: EpicHeading, state: EpicState }),
	// Shown in the epic's thread and in the main chat.
	Schema.TaggedStruct('pullRequestOpened', { thread: ThreadRef, epic: EpicHeading, url: Schema.String }),
	// One line in the archive thread (`openArchive`).
	Schema.TaggedStruct('epicShipped', { archive: ThreadRef, epic: EpicHeading, pullRequestUrl: Schema.NullOr(Schema.String), slices: Schema.Int }),
	Schema.TaggedStruct('closeThread', { thread: ThreadRef }),
	// A sub-issue of the epic started or was done.
	Schema.TaggedStruct('sliceMoved', { thread: ThreadRef, slice: EpicHeading, progress: SliceProgress }),
	// When it started tells two runs of the same phase apart.
	Schema.TaggedStruct('phaseStarted', { thread: ThreadRef, phase: Phase, startedAt: Schema.Int }),
	// The run waits for input, and shows what it last printed. When it went quiet tells its questions apart.
	Schema.TaggedStruct('question', { thread: ThreadRef, text: Schema.String, askedAt: Schema.Int }),
]);

export type Intent = typeof Intent.Type;

// The chat platform, as core uses it. The live layer is Telegram's (`telegram.ts`).
export class Chat extends Context.Service<
	Chat,
	{
		// Messages from allowed users, oldest first, those sent while the service was down included. Messages from anyone
		// else are dropped and logged. One consumer only.
		readonly inbound: Stream.Stream<InboundMessage>;
		readonly send: (intent: Intent) => Effect.Effect<void, CallError>;
		// Shows the text as it streams in, as an answer to the message, and keeps it once the stream ends or the user stops
		// it, which interrupts the stream. Returns the messages it was kept as; none when nothing was written.
		readonly streamReply: (to: MessageRef, text: Stream.Stream<string>) => Effect.Effect<ReadonlyArray<MessageRef>, CallError>;
		// A new thread for the epic, showing the state.
		readonly openEpic: (epic: EpicHeading, state: EpicState) => Effect.Effect<ThreadRef, CallError>;
		// A new thread for the summaries of shipped epics.
		readonly openArchive: Effect.Effect<ThreadRef, CallError>;
	}
>()('sapphire-agent/Chat') {}
