import { Option, Schema } from 'effect';

// What a comment is for. Together with the epic's identifier (or a command's, `CMD-<id>`) and a key it names one comment, so a write first looks
// for its marker and skips if it is there: a retry or a restart never posts twice, while a later occurrence (a new
// question in the same run, a new summary from a follow-up run) has a new key and is posted. The Comments service
// builds every key; `claimedAt` is the run's claim time in epoch ms.
//
// On the Linear epic:
// - awaitingInput: `<claimedAt>-<agentStatusSince>`, one per quiet episode of a run.
// - stale: `<claimedAt>-<nudgedAt>`, one per nudged episode of a run.
// - error, startFailed, invalidResult, noPullRequest, threadMismatch, overCap, permanentFailure: `<claimedAt>`, once per run.
// - keptWorktree: `<claimedAt>`, once per run; `<worktreePath>` for an orphan worktree that no run tracks.
// - replyFailed: `<replyCommentId>`, the user's reply that could not be typed; posted under the question.
// - transientFailure: `<streakStartedAt>` from `Journal.recordTransient`, once per streak of transient failures.
// - workingOrphan: `<tabId>`, once per untracked tab whose agent is working.
// On the GitHub PR, as the bot:
// - summary, flags: `<claimedAt>`, once per run (flags is the review holding every flag).
// - reply: `<threadId>.<claimedAt>`, once per thread per run; found among the thread's comments.
// On the issue or PR a command came from, as the bot:
// - commandReply: `<requestId>`, once per reply the command's agent asked for.
// - commandFailed: `<claimedAt>`, once per command that failed.
export const MarkerPurpose = Schema.Literals([
	'awaitingInput',
	'stale',
	'error',
	'startFailed',
	'invalidResult',
	'noPullRequest',
	'threadMismatch',
	'overCap',
	'permanentFailure',
	'keptWorktree',
	'replyFailed',
	'transientFailure',
	'workingOrphan',
	'summary',
	'flags',
	'reply',
	'commandReply',
	'commandFailed',
]);

export type MarkerPurpose = typeof MarkerPurpose.Type;

export type Marker = {
	readonly identifier: string;
	readonly purpose: MarkerPurpose;
	readonly key: string;
};

// A comment body that already ends with its rendered marker.
export type MarkedComment = {
	readonly marker: Marker;
	readonly body: string;
};

// The key is URI-encoded so a path or id never breaks the HTML comment or the parser.
export const renderMarker = ({ identifier, purpose, key }: Marker) => `<!-- sapphire-agent:${identifier}:${purpose}:${encodeURIComponent(key)} -->`;

export const withMarker = (body: string, marker: Marker): MarkedComment => ({ marker, body: `${body}\n\n${renderMarker(marker)}` });

// Only a marker on a line of its own counts, so a user quoting one of our comments (`> <!-- ... -->`) is not ours.
// Comments posted before the rename carry `herdr-linear:`.
const markerLine = /^<!-- (?:sapphire-agent|herdr-linear):([A-Z]+-\d+):(\w+):(\S+) -->$/m;

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
