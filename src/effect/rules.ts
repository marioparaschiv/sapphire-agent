import { Effect } from 'effect';
import { cleanupRule } from './cleanup.ts';
import { dispatchRule, startRule } from './dispatch.ts';
import { monitoringRule } from './monitoring.ts';
import { resultsRule } from './results.ts';

// Every rule, in the order the planner runs them. Cleanup and results end runs before monitoring looks at them, so
// one tick never flags a run it just ended. Claims come last (follow-ups before ready epics, as both count against
// maxInFlight) so the start rule starts them in the same tick.
export const rules = Effect.all([cleanupRule, resultsRule, monitoringRule, dispatchRule, startRule]);
