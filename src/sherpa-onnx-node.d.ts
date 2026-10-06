// sherpa-onnx-node ships no type declarations; this covers the part transcription.ts uses, as its JSDoc in types.js
// describes it.
declare module 'sherpa-onnx-node' {
	type OfflineRecognizerConfig = {
		readonly featConfig: { readonly sampleRate: number; readonly featureDim: number };
		readonly modelConfig: {
			readonly transducer: { readonly encoder: string; readonly decoder: string; readonly joiner: string };
			readonly tokens: string;
			readonly modelType: string;
			readonly numThreads: number;
		};
	};

	class OfflineStream {
		acceptWaveform(waveform: { readonly samples: Float32Array; readonly sampleRate: number }): void;
	}

	class OfflineRecognizer {
		static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
		createStream(): OfflineStream;
		// The result as JSON.parse returns it.
		decodeAsync(stream: OfflineStream): Promise<unknown>;
	}

	const sherpa: { readonly OfflineRecognizer: typeof OfflineRecognizer };

	export default sherpa;
}
