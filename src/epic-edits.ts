import { Clock, Duration, Effect, Equal, Option } from 'effect';
import { AppConfig } from './config.ts';
import { type EditedField, type EpicEdit, type EpicSnapshot, type IssueSnapshot, Journal, type Run } from './journal.ts';
import { type HistoryEntry, Linear, type TrackedIssue } from './linear.ts';
import { acceptsMessages, isInFlight, type Observation } from './observation.ts';
import type { Rule, Work } from './planner.ts';
import { Prompts } from './prompts.ts';
import { Reconciler } from './reconciler.ts';
import { makeSend } from './run-actions.ts';
import { Summariser } from './summariser.ts';

// The state the orchestrator moves a finished sub-issue to; its team's other states are not in the config.
const subIssueDoneState = 'Done';

// `ignoredLabels` are left out, so they never differ.
const snapshotOf = (issue: TrackedIssue, ignoredLabels: ReadonlyArray<string> = []): IssueSnapshot => ({
	id: issue.id,
	identifier: issue.identifier,
	title: issue.title,
	description: issue.description ?? '',
	state: issue.state.name,
	labels: issue.labels.nodes.flatMap(({ name }) => (ignoredLabels.includes(name) ? [] : [name])).toSorted(),
	blockedBy: issue.inverseRelations.nodes.flatMap((relation) => (relation.type === 'blocks' ? [relation.issue.identifier] : [])).toSorted(),
});

const listed = (values: ReadonlyArray<string>) => (values.length === 0 ? null : values.join(', '));

// The edits that turn the issues of `before` into those of `after`.
const editsBetween = (before: ReadonlyArray<IssueSnapshot>, after: ReadonlyArray<IssueSnapshot>): ReadonlyArray<EpicEdit> => {
	const previous = new Map(before.map((issue) => [issue.id, issue]));
	const current = new Set(after.map(({ id }) => id));
	const edit = (issue: IssueSnapshot, field: EditedField, from: string | null, to: string | null): ReadonlyArray<EpicEdit> =>
		from === to ? [] : [{ issueId: issue.id, identifier: issue.identifier, field, before: from, after: to }];

	return [
		...after.flatMap((issue) => {
			const was = previous.get(issue.id);

			if (was === undefined) {
				return edit(issue, 'subIssue', null, issue.title);
			}

			return [
				...edit(issue, 'title', was.title, issue.title),
				...edit(issue, 'description', was.description || null, issue.description || null),
				...edit(issue, 'state', was.state, issue.state),
				...edit(issue, 'labels', listed(was.labels), listed(issue.labels)),
				...edit(issue, 'blockedBy', listed(was.blockedBy), listed(issue.blockedBy)),
			];
		}),
		...before.filter(({ id }) => !current.has(id)).flatMap((issue) => edit(issue, 'subIssue', issue.title, null)),
	];
};

const fieldNames: Record<Exclude<EditedField, 'subIssue'>, string> = { title: 'title', description: 'description', state: 'state', labels: 'labels', blockedBy: 'blocked by' };

const describeEdit = ({ identifier, field, before, after }: EpicEdit) => {
	if (field === 'subIssue') {
		return after === null ? `- ${identifier} "${before}" is no longer a sub-issue` : `- ${identifier} "${after}" is a new sub-issue`;
	}

	return `- ${identifier} ${fieldNames[field]}\n  before: ${before ?? 'none'}\n  after: ${after ?? 'none'}`;
};

const touches = (edit: EpicEdit, epicId: string, entry: HistoryEntry) => {
	switch (edit.field) {
		case 'title':
			return entry.toTitle !== null;
		case 'description':
			return entry.updatedDescription === true;
		case 'state':
			return entry.toStateId !== null;
		case 'labels':
			return (entry.addedLabelIds?.length ?? 0) + (entry.removedLabelIds?.length ?? 0) > 0;
		case 'blockedBy':
			return (entry.relationChanges?.length ?? 0) > 0;
		case 'subIssue':
			return edit.after === null ? entry.fromParentId === epicId : entry.toParentId === epicId;
	}
};

// Linear's automations record a botActor. The owner, sapphire-agent (its API key is the owner's) and the run's agent
// (through the Linear MCP server) all record the owner with none, so an edit is only known to be an automation's when
// every history entry since the snapshot that touches its field has one.
const isAutomation = (edit: EpicEdit, epicId: string, takenAt: number, histories: ReadonlyMap<string, ReadonlyArray<HistoryEntry>>) => {
	const entries = (histories.get(edit.issueId) ?? []).filter((entry) => Date.parse(entry.createdAt) >= takenAt && touches(edit, epicId, entry));

	return entries.length > 0 && entries.every((entry) => entry.botActor !== null);
};

// Tells a run's agent when its epic or sub-issues are edited: their title, description, state, labels or blockers, or
// which sub-issues it has. The bot's edits cannot be told from the owner's by who made them, so the ones it makes by
// design are left out by what they are: any move of the epic (sapphire-agent and the orchestrator own its state), a
// sub-issue moving to Implementing or Done (as the orchestrator moves them) and the stuck label on the epic (a flag).
// Linear's automations are left out too. The epic's tree is snapshotted at the claim. Each tick compares it with Linear;
// edits left out are taken into the snapshot silently. The others are recorded with when they last changed, and once
// editDebounceSeconds passed without another, the summary model condenses them into one message (or they are sent as
// listed if it cannot), sent to the run's thread with mode auto, which starts an idle thread. Then the snapshot is taken
// again. The message is keyed by when the edits last changed, so after a crash T3 drops it if it took it already.
// Notification only: never changes the run. Not paused, as it watches runs in flight.
export const epicEditsRule = Effect.gen(function* () {
	const { editDebounceSeconds, states, labels } = yield* AppConfig;
	const journal = yield* Journal;
	const linear = yield* Linear;
	const prompts = yield* Prompts;
	const summariser = yield* Summariser;
	const sendToThread = yield* makeSend;

	const isByDesign = (edit: EpicEdit, epicId: string) =>
		edit.field === 'state' && (edit.issueId === epicId || edit.after === states.implementing || edit.after === subIssueDoneState);

	const message = (edits: ReadonlyArray<EpicEdit>) => {
		const listing = edits.map(describeEdit).join('\n');

		return summariser.summarise(prompts.summariseEdits(listing)).pipe(
			Effect.catch((error) => Effect.logWarning('cannot summarise the edits; sending them as listed', error).pipe(Effect.as(prompts.listedEdits(listing)))),
			Effect.map((summary) => prompts.epicEdited(summary, [...new Set(edits.map(({ identifier }) => identifier))])),
		);
	};

	const watch = (run: Run, snapshot: Option.Option<EpicSnapshot>) =>
		Effect.gen(function* () {
			const readAt = yield* Clock.currentTimeMillis;
			const tree = yield* linear.epicTree(run.epicId);
			const fresh: EpicSnapshot = { epicId: run.epicId, claimedAt: run.claimedAt, takenAt: readAt, issues: [snapshotOf(tree, [labels.stuck]), ...tree.children.nodes.map((child) => snapshotOf(child))], edits: null, editedAt: null };

			if (Option.isNone(snapshot) || snapshot.value.claimedAt !== run.claimedAt) {
				return yield* journal.putEpicSnapshot(fresh);
			}

			const taken = snapshot.value;
			const changes = editsBetween(taken.issues, fresh.issues);
			const candidates = changes.filter((edit) => !isByDesign(edit, tree.id));
			const histories = yield* linear.issueHistories([...new Set(candidates.map(({ issueId }) => issueId))]);
			const edits = candidates.filter((edit) => !isAutomation(edit, tree.id, taken.takenAt, histories));

			if (edits.length === 0) {
				if (changes.length > 0 || taken.edits !== null) {
					yield* journal.putEpicSnapshot(fresh);
				}

				return;
			}

			const unchanged = taken.edits !== null && Equal.equals(taken.edits, edits);
			const editedAt = unchanged && taken.editedAt !== null ? taken.editedAt : readAt;

			if (!unchanged) {
				yield* journal.putEpicSnapshot({ ...taken, edits, editedAt });
			}

			if (readAt - editedAt < editDebounceSeconds * 1000 || !acceptsMessages(run)) {
				return;
			}

			yield* sendToThread(run, yield* message(edits), { mode: 'auto', clientRequestId: `edits-${run.claimedAt}-${editedAt}` });
			yield* journal.putEpicSnapshot(fresh);
		});

	const plan = (observation: Observation) =>
		Effect.gen(function* () {
			const runs = (yield* journal.listRuns).filter(isInFlight);
			const snapshots = yield* journal.listEpicSnapshots;
			const stale = snapshots.filter((snapshot) => !runs.some((run) => run.epicId === snapshot.epicId));
			const work: Array<Work> = runs
				.filter((run) => observation.epics.has(run.epicId))
				.map((run) => ({
					epicId: run.epicId,
					identifier: run.identifier,
					teamId: run.teamId,
					apply: watch(run, Option.fromUndefinedOr(snapshots.find((snapshot) => snapshot.epicId === run.epicId))),
				}));

			if (stale.length > 0) {
				work.push({ task: 'epic snapshots', apply: Effect.forEach(stale, ({ epicId }) => journal.deleteEpicSnapshot(epicId), { discard: true }) });
			}

			return work;
		});

	return { name: 'epic-edits', pausable: false, plan } satisfies Rule;
});

// How often the journal is read for edits whose debounce window ended.
const dueCheckInterval = Duration.seconds(5);

// Wakes the reconciler once a run's edits waited editDebounceSeconds, so they are sent then rather than at the next
// poll.
export const wakeForEpicEdits = Effect.gen(function* () {
	const { editDebounceSeconds } = yield* AppConfig;
	const journal = yield* Journal;
	const reconciler = yield* Reconciler;
	let checkedAt = yield* Clock.currentTimeMillis;

	const check = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const dueTimes = (yield* journal.listEpicSnapshots).flatMap(({ editedAt }) => (editedAt === null ? [] : [editedAt + editDebounceSeconds * 1000]));
		const due = dueTimes.some((dueAt) => dueAt > checkedAt && dueAt <= now);

		checkedAt = now;

		if (due) {
			yield* reconciler.wake;
		}
	}).pipe(Effect.catch((error) => Effect.logWarning('cannot read the epic snapshots; edits wait for the next tick', error)));

	return yield* Effect.forever(Effect.sleep(dueCheckInterval).pipe(Effect.andThen(check)));
});
