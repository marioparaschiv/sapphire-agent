import { Effect } from 'effect';
import { cleanupRule } from './cleanup.ts';
import { commandsRule } from './commands.ts';
import { dispatchRule, startRule } from './dispatch.ts';
import { epicEditsRule } from './epic-edits.ts';
import { followUpRule } from './follow-up.ts';
import { handoffRule } from './handoffs.ts';
import { monitoringRule } from './monitoring.ts';
import { noticesRule } from './notices.ts';
import { requestsRule } from './requests.ts';
import { resultsRule } from './results.ts';

// Every rule, in the order the planner runs them. Requests come first, so a stopped run is ended before anything else
// looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just
// ended. Handoffs follow monitoring, which records when a turn ended. Claims come next (follow-ups before ready epics,
// as both count against maxInFlight) so the start rule starts them in the same tick. Epic edits follow the start, so a
// run claimed this tick has its epic snapshotted after the start moved it. Notices go last, so what every rule wrote
// this tick is posted in it.
export const rules = Effect.all([requestsRule, cleanupRule, resultsRule, monitoringRule, handoffRule, followUpRule, dispatchRule, startRule, epicEditsRule, commandsRule, noticesRule]);
