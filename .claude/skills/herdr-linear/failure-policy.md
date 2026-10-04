# Failure policy

How every external call is bounded and classified, how a failure is retried, and when a failing epic is flagged.

## Two kinds of failure

Every call to herdr, git, gh and Linear fails with one of two tagged errors (`call-policy.ts`):

| Error | Means | Examples |
| --- | --- | --- |
| `Transient` | Worth retrying. May carry `retryAfter`, the server's Retry-After. | A timeout, HTTP 5xx, a network error, a rate limit, a git lock file held by another process, herdr's server not running. |
| `Permanent` | Retrying cannot help. | HTTP 4xx, a GraphQL error, a response that fails its schema, a missing repo, any other herdr error code, an unresolvable repo label. |

Per service:

- Linear: HTTP 429, or HTTP 400 with the GraphQL code `RATELIMITED` (how Linear reports most rate limits), is Transient with `retryAfter`. 5xx and transport errors are Transient. Other 4xx, GraphQL errors and decode failures are Permanent.
- gh: Transient when stderr shows a connection error, a timeout, HTTP 5xx, HTTP 429 or a rate limit; otherwise Permanent. gh exits non-zero on GraphQL errors.
- git: Transient for a held lock file, and for a network error during `fetch` or `pull`; otherwise Permanent.
- herdr: Transient when the server is not running; any other error code is Permanent. Some codes (`pane_not_found`, `agent_not_found`, `tab_not_found`) are answers rather than errors where the caller asks whether something exists.

## The call policy

`withCallPolicy(timeout)` wraps every external call:

- A timeout per attempt: herdr and git 30 s, gh and Linear 20 s. A timeout is a Transient.
- Up to 3 retries of a Transient, after 1 s, 2 s and 4 s, each jittered, or after exactly `retryAfter` when the error has one.
- A Permanent is not retried. Once the retries are used up, the Transient fails the call and the epic's work for this tick; the next tick tries again.

Each method is one unit under the policy, so a retried write repeats its marker or state check before writing again.

herdr writes that have nothing to check first (creating a workspace or tab, starting Claude, typing into a pane) use the write policy instead: the timeout covers all attempts together and a timeout is never retried, because the timed-out attempt may still have landed. Transient failures before the timeout (herdr's server not running) are still retried. The next tick observes what actually happened.

## At the epic level

The planner runs every rule's work per epic in its own fiber, so one bad epic never blocks the others, and handles what the work fails with:

- Success clears the epic's transient streak.
- Transient: logged as `failed; retrying next tick`. The journal records when the epic's streak started. Once the streak is older than `flagTransientAfterSeconds` (default 600), a `transientFailure` comment is posted once per streak (no label: it keeps retrying by itself). No Linear comment before that.
- Transient with `retryAfter` (a rate limit): the rest of the tick is skipped (`rate limited; skipping <rule> and the rules after it until the next tick`). The call policy already waited Retry-After between its attempts.
- Permanent: logged as `failed`, and the epic is flagged once with `permanentFailure` and `agent-stuck`, keyed by the run's claim time (or, without a run, by the streak start).
- Anything else (a defect, a journal error) is logged with the rule and epic and dropped; the next tick tries again. Interruption (shutdown) still stops the tick.

Work that is not about an epic (`TaskWork`: a command, a request whose epic has no run) has nothing to flag, so the planner only logs its failures with its `task`. A command handles its own: a Transient failure is logged and tried again next tick, a Permanent one while starting fails the command with a reply on GitHub (`rules.md`). A webhook delivery whose command cannot be recorded is answered 500 and logged, so it stays failed in the App's delivery log until the delivery scan redelivers it. The scan's own GitHub calls go through the call policy; a scan that still fails, or a redelivery GitHub refuses, is logged and tried again on the next scan, without moving the delivery mark (`rules.md`, Missed deliveries).

A failure while observing or planning skips that tick or that rule and is logged; nothing is written.

Rule code may handle a failure itself where that is the behaviour: a Permanent while starting becomes `startFailed`, a refused reply becomes a `replyFailed` notice, a failed nudge is only logged (the stale flag follows anyway), and a repo whose worktrees cannot be listed only skips its orphan worktrees.

## Concurrency

- Rules run one after another; within a rule, epics run in parallel.
- Starts share one semaphore: they race on `~/.claude.json` and on creating the workspace. A command starts in a later rule, so never at the same time as a run.
- git calls share one semaphore per repo: git takes lock files in the main repo for operations in any of its worktrees.
