import { Schema } from 'effect';

const Text = Schema.NonEmptyString;

// What the agent writes as the last step of a run. A valid file is the run's completion signal.
export const ResultFile = Schema.Struct({
	summary: Text,
	replies: Schema.Array(Schema.Struct({ threadId: Text, body: Text })),
	flags: Schema.Array(Schema.Struct({ path: Text, line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), body: Text })),
});

export type ResultFile = typeof ResultFile.Type;
