import { Effect, Schema } from 'effect';

const Text = Schema.NonEmptyString;

// What the agent writes as the last step of a run. A valid file is the run's completion signal.
export const ResultFile = Schema.Struct({
	summary: Text,
	replies: Schema.Array(Schema.Struct({ threadId: Text, body: Text })),
	flags: Schema.Array(Schema.Struct({ path: Text, line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), body: Text })),
});

export type ResultFile = typeof ResultFile.Type;

export class InvalidResultFile extends Schema.TaggedError<InvalidResultFile>()('InvalidResultFile', { message: Schema.String }) {}

export const decodeResultFile = (text: string) =>
	Schema.decodeEffect(Schema.fromJsonString(ResultFile))(text).pipe(Effect.mapError((error) => new InvalidResultFile({ message: error.message })));
