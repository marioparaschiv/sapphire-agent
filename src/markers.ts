import { Option, Schema } from 'effect';

// What a marked write is for. Together with the epic's identifier (or a command's, `CMD-<id>`) and a key it names one
// write, so a write first looks for its marker and skips if it is there: a retry or a restart never posts twice, while
// a later occurrence (a new stall in the same run, a new summary from a follow-up run) has a new key and is posted.
// The Comments service builds every key; `claimedAt` is the run's claim time in epoch ms.
//
// On the Linear epic:
// - pullRequestOpened: `<url>`, once per PR, whatever run saw it first.
// On the GitHub PR, as the bot:
// - reply: `<threadId>.<claimedAt>`, once per thread per run; found among the thread's comments.
// - addressed: `<claimedAt>`, once per run that replied to a thread.
// On the issue or PR of a command's comment, as the bot:
// - commandReply: `<requestId>`, once per reply a command's agent asked for.
// - commandFailed: `<claimedAt>` of the command, once per command that failed.
// Notices, in the journal's outbox once per marker, then on the Linear epic:
// - stale: `<claimedAt>-<nudgedAt>`, one per nudged episode of a run.
// - startFailed, invalidResult, noPullRequest, threadMismatch, overCap, permanentFailure, summary, flags:
//   `<claimedAt>`, once per run (permanentFailure without a run: once per failure streak).
// - keptWorktree: `<claimedAt>`, once per run; `<worktreePath>` for an orphan worktree that no run tracks.
// - transientFailure: `<streakStartedAt>` from `Journal.recordTransient`, once per streak of transient failures.
// - handoffMissing: `<sessionId>`, once per orchestrator session that wrote no handoff doc.
// - subagentOverContext: `<agentId>`, once per subagent that went on past its handoff.
export const MarkerPurpose = Schema.Literals([
	'stale',
	'startFailed',
	'invalidResult',
	'noPullRequest',
	'threadMismatch',
	'overCap',
	'permanentFailure',
	'keptWorktree',
	'transientFailure',
	'summary',
	'flags',
	'reply',
	'addressed',
	'pullRequestOpened',
	'commandReply',
	'commandFailed',
	'handoffMissing',
	'subagentOverContext',
]);

export type MarkerPurpose = typeof MarkerPurpose.Type;

export const Marker = Schema.Struct({ identifier: Schema.String, purpose: MarkerPurpose, key: Schema.String });

export type Marker = typeof Marker.Type;

// A comment body that already ends with its rendered marker.
export type MarkedComment = {
	readonly marker: Marker;
	readonly body: string;
};

// The key is URI-encoded so a path or id never breaks the HTML comment or the parser.
export const renderMarker = ({ identifier, purpose, key }: Marker) => `<!-- sapphire-agent:${identifier}:${purpose}:${encodeURIComponent(key)} -->`;

// A short markdown message for the user, posted on the epic once per marker (`Journal.addNotice`).
export type Notice = {
	readonly marker: Marker;
	readonly text: string;
};

export const withMarker = (body: string, marker: Marker): MarkedComment => ({ marker, body: `${body}\n\n${renderMarker(marker)}` });

// Only a marker on a line of its own counts, so a user quoting one of our comments (`> <!-- ... -->`) is not ours.
const markerLine = /^<!-- sapphire-agent:([A-Z]+-\d+):(\w+):(\S+) -->$/m;

const decodePurpose = Schema.decodeUnknownOption(MarkerPurpose);

const decodeKey = Option.liftThrowable(decodeURIComponent);

export const parseMarker = (body: string): Option.Option<Marker> => {
	const match = markerLine.exec(body);

	if (!match) {
		return Option.none();
	}

	const [, identifier, purpose, key] = match;

	return Option.all({ identifier: Option.some(identifier), purpose: decodePurpose(purpose), key: decodeKey(key) });
};

const isSameMarker = (a: Marker, b: Marker) => a.identifier === b.identifier && a.purpose === b.purpose && a.key === b.key;

export const hasMarker = (body: string, marker: Marker) =>
	Option.match(parseMarker(body), { onNone: () => false, onSome: (found) => isSameMarker(found, marker) });
