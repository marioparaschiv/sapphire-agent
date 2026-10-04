import { Effect } from 'effect';
import { cleanupRule } from './cleanup.ts';
import { commandsRule } from './commands.ts';
import { dispatchRule, startRule } from './dispatch.ts';
import { followUpRule } from './follow-up.ts';
import { mentionsRule } from './mentions.ts';
import { monitoringRule } from './monitoring.ts';
import { requestsRule } from './requests.ts';
import { resultsRule } from './results.ts';

// Every rule, in the order the planner runs them. Requests come first, so a stopped run is ended before anything else
// looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just
// ended. Claims come next (follow-ups before ready epics, as both count against maxInFlight) so the start rule starts
// them in the same tick. Mentions are read last and the commands rule starts the new one in the same tick.
export const rules = Effect.all([requestsRule, cleanupRule, resultsRule, monitoringRule, followUpRule, dispatchRule, startRule, mentionsRule, commandsRule]);
