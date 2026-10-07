# T3 and git

How a run starts as a T3 Code thread, where its worktree comes from, and how the Git service works with the worktrees and the result file. The start rule's steps and their crash safety are in `rules.md` (Start); the T3 service and the thread waits are in `architecture.md`.

## Starting a run

The start rule launches one full-access thread per claimed run in the T3 project of the run's repo (`T3Projects.projectFor`), titled `<ID> <title, cut to 40 chars with an ellipsis>` (`Prompts.threadTitle`), with the orchestrate or follow-up prompt as its message. A new run gets `workspaceStrategy` `{ type: "worktree", baseRef: <origin's default branch>, branch: <epic branch>, startFromOrigin: true }`, so T3 makes the worktree after the launch answered; the start rule records its path once T3 reports it. A worktree already on the branch, and every follow-up, use `existing_worktree` on that worktree instead (a follow-up's worktree is prepared and pulled first, below). A thread a handoff starts is titled `<ID> (2) <title>`, counting up, on the same worktree and branch.

A command runs in its own supervised thread in a checkout of the comment's repo under `$STATE/commands` (`rules.md`, Commands).

## Worktrees (`Git` service)

- Path: `<worktreesDirectory>/<basename(repo)>/<branch with [^A-Za-z0-9._-]+ replaced by ->`, e.g. `~/.t3/worktrees/unbound/mario-unb-12-settings-sync`. This is the layout T3 makes its worktrees in, so `worktreesDirectory` must be T3's own setting.
- `prepareWorktree` (follow-ups) always runs `git fetch origin` first, then:
  - path exists: reuse it if it has the same branch checked out, else fail Permanently;
  - local branch exists: `git worktree add <path> <branch>`;
  - only on origin: `git worktree add --track -b <branch> <path> origin/<branch>`;
  - new: `git worktree add --no-track -b <branch> <path> <origin default>`, so a plain `git push` never targets the default branch. The default comes from `origin/HEAD`, set with `remote set-head --auto` if missing.
- `pull`: `git pull --ff-only origin <branch>` for follow-up runs, so they start from what is on the PR. Origin is named explicitly since a branch created without tracking has no upstream.
- `checkoutDefaultBranch`: a worktree of a clone at `$STATE/commands/<repo>`, on no branch at origin's default branch as fetched now; made if missing, refreshed at each command start.
- `unsavedWork`: uncommitted changes (`git status --porcelain`, untracked files count, ignored ones do not), or commits on the worktree's `HEAD` or the local branch that no `origin/*` ref contains (`N unpushed commits`). Commits a merged PR's head contains count as pushed. A branch never pushed is unsaved once it has commits beyond the default branch. No fetch first: `git push` already updates the remote-tracking ref.
- `removeWorktree`: `git worktree remove <path>` (no `--force`), `git worktree prune` (for a directory deleted by hand), `git branch -D <branch>`. Each step is skipped when already done, so it can run again after a crash. A later run starts again from `origin/<branch>`.
- `listWorktrees`: every worktree of a repo under the worktrees directory with a branch checked out; ownership is decided by the cleanup rule.
- `githubRepo`: `owner/name` from the repo's `origin` URL, which must be GitHub.
- Result file: `sapphire-agent-result.json` in the worktree's git dir (`git rev-parse --absolute-git-dir`). `readResultFile` decodes it with the `ResultFile` schema and fails `InvalidResultFile` otherwise; `removeResultFile` deletes a leftover one when a run starts in a reused worktree.
- git calls in one repo share a semaphore, since git takes lock files in the main repo for all of its worktrees.
