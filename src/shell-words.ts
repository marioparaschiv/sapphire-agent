// Shell commands split into words the way the guards read them.

// A shell word with its quotes removed; `quoted` when any of it was quoted or escaped, so it is no operator.
type Word = { readonly text: string; readonly quoted: boolean };

// Splits a shell command into its simple commands, each a list of words with quotes removed, redirections kept. Not a
// shell: no expansions, subshells or heredocs.
export const shellWords = (command: string) => {
	const commands: Array<Array<Word>> = [];
	let words: Array<Word> = [];
	let word = '';
	let inWord = false;
	let quoted = false;
	let quote: string | null = null;

	const endWord = () => {
		if (inWord) {
			words.push({ text: word, quoted });
		}

		word = '';
		inWord = false;
		quoted = false;
	};

	const endCommand = () => {
		endWord();

		if (words.length > 0) {
			commands.push(words);
		}

		words = [];
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? '';

		if (quote !== null) {
			if (char === quote) {
				quote = null;
			} else if (char === '\\' && quote === '"' && index + 1 < command.length) {
				word += command[++index];
			} else {
				word += char;
			}

			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			inWord = true;
			quoted = true;
		} else if (char === '\\' && index + 1 < command.length) {
			word += command[++index];
			inWord = true;
			quoted = true;
		} else if (char === '&' && (word.endsWith('>') || word.endsWith('<'))) {
			word += char;
		} else if (';&|\n()`'.includes(char)) {
			endCommand();
		} else if (char === ' ' || char === '\t') {
			endWord();
		} else {
			word += char;
			inWord = true;
		}
	}

	endCommand();

	return commands;
};

export const isRedirection = ({ text, quoted }: Word) => !quoted && /^\d*(?:>>?|<|>&|<&)/.test(text);

// The simple commands of a shell command, without their redirections.
export const simpleCommands = (command: string) =>
	shellWords(command).map((commandWords) => {
		const kept: Array<string> = [];

		for (let index = 0; index < commandWords.length; index++) {
			const current = commandWords[index] ?? { text: '', quoted: false };

			if (isRedirection(current)) {
				// `> file` names its target in the next word; `>file` and `2>&1` do not.
				if (/^\d*(?:>>?|<|>&|<&)$/.test(current.text)) {
					index++;
				}

				continue;
			}

			kept.push(current.text);
		}

		return kept;
	});

// A command or process substitution outside single quotes, whose command the words do not show.
export const hasSubstitution = (command: string) => {
	let quote: string | null = null;

	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? '';

		if (quote === "'") {
			quote = char === "'" ? null : quote;
		} else if (char === '\\') {
			index++;
		} else if (char === '`' || (char === '$' && command[index + 1] === '(')) {
			return true;
		} else if (char === "'" && quote === null) {
			quote = char;
		} else if (char === '"') {
			quote = quote === '"' ? null : char;
		}
	}

	return false;
};

