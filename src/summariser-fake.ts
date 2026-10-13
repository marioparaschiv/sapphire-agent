import { Context, Effect, Layer } from 'effect';
import { Permanent } from './call-policy.ts';
import { Summariser } from './summariser.ts';

export type FakeSummariserControls = {
	// The prompts the model was given, oldest first.
	readonly prompts: () => ReadonlyArray<string>;
	// From now on the model answers this, or with null fails as `claude` exiting non-zero does.
	readonly answerWith: (summary: string | null) => void;
};

export class FakeSummariser extends Context.Service<FakeSummariser, FakeSummariserControls>()('sapphire-agent/FakeSummariser') {
	static readonly layer = Layer.effectContext(
		Effect.sync(() => {
			const prompts: Array<string> = [];
			let answer: string | null = 'The owner edited the epic.';

			const summarise = (prompt: string) =>
				Effect.suspend(() => {
					prompts.push(prompt);

					return answer === null ? Effect.fail(new Permanent({ message: 'claude -p --model claude-haiku-5-5 failed with exit code 1: API Error: 529 Overloaded' })) : Effect.succeed(answer);
				});

			const controls: FakeSummariserControls = {
				prompts: () => [...prompts],
				answerWith: (summary) => {
					answer = summary;
				},
			};

			return Context.make(Summariser, Summariser.of({ summarise })).pipe(Context.add(FakeSummariser, controls));
		}),
	);
}
