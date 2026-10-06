import { Effect } from 'effect';
import { cleanupRule } from './cleanup.ts';
import { commandsRule } from './commands.ts';
import { dispatchRule, startRule } from './dispatch.ts';
import { followUpRule } from './follow-up.ts';
import { handoffRule } from './handoffs.ts';
import { monitoringRule } from './monitoring.ts';
import { noticesRule } from './notices.ts';
import { projectTopicsRule } from './project-topics.ts';
import { requestsRule } from './requests.ts';
import { resultsRule } from './results.ts';
import { topicsRule } from './topics.ts';

// Every rule, in the order the planner runs them. Requests come first, so a stopped run is ended before anything else
// looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just
// ended. Handoffs follow monitoring, which records when a turn ended. Claims come next (follow-ups before ready epics, as both count against maxInFlight) so the start rule starts
// them in the same tick. Topics come after them, so a run dispatched this tick gets its chat thread at once, and each
// thread shows what this tick's rules left. A project added by a request gets its thread in the same tick. Notices go
// last, so what every rule wrote this tick is sent in it, to the threads opened in it.
export const rules = Effect.all([requestsRule, cleanupRule, resultsRule, monitoringRule, handoffRule, followUpRule, dispatchRule, startRule, topicsRule, projectTopicsRule, commandsRule, noticesRule]);
