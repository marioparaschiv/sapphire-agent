<div align="center">

<img src="./assets/logo.png" width="120" alt="Sapphire Agent logo" />

<h1>Sapphire Agent</h1>

<b>An autonomous project manager for coding agents.</b>

Move a Linear epic to Ready For Agent and get a reviewed pull request back.

<br />

[![Node](https://img.shields.io/badge/node-%E2%89%A524-2c4f8f?style=for-the-badge&labelColor=0c0c0c)](https://nodejs.org)
[![Effect](https://img.shields.io/badge/effect-4-2c4f8f?style=for-the-badge&labelColor=0c0c0c)](https://effect.website)
[![TypeScript](https://img.shields.io/badge/typescript-7-2c4f8f?style=for-the-badge&labelColor=0c0c0c)](https://www.typescriptlang.org)

[Install](#installation) · [Usage](#usage) · [Architecture](#architecture)

</div>

## Contents

- **For Users:** [What Is Sapphire Agent?](#what-is-sapphire-agent) · [Features](#features) · [Installation](#installation) · [Usage](#usage)
- **For Developers:** [Developing Sapphire Agent](#developing-sapphire-agent) · [Architecture](#architecture)

## For Users

### What Is Sapphire Agent?

Sapphire Agent runs on your machine as a systemd user service and watches your Linear teams. When an epic lands in Ready For Agent, it opens a [T3 Code](https://t3.codes) thread in a fresh git worktree, and whichever coding agent T3 uses by default works through the sub-issues there. When the work is done, the agent opens a PR and reviews it, and the service posts the result back on the epic.

You review the PR the normal way. To ask for changes, mention the bot in a comment in plain language. It replies, starts a follow-up run on the same branch, and resolves each thread it addressed. Once the PR merges, it removes the worktree, the branch and the thread.

### Features

| Feature           | Description                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Epic dispatch     | Each ready epic gets its own worktree and agent, with a cap on how many run at once.                        |
| Linear sync       | Epics move through Implementing, In Review and To Review on their own.                                      |
| Review by mention | Mentioning the bot on a PR can pause, stop, dispatch, pass a message to an agent or ask for a follow-up.    |
| Stall detection   | A run that goes quiet gets a nudge, then a flag. A run past its time limit is flagged once and keeps going. |
| Context handoffs  | Before an agent's context fills up, it writes a handoff doc and a fresh agent picks it up.                  |
| Crash safety      | State lives in SQLite and every write is idempotent, so a restart picks up where it left off.               |

### Installation

Requirements: Node 24, `git`, a logged-in `gh`, a running T3 Code server, a Linear API key and a GitHub App for the bot.

1. Clone and install:

    ```bash
    git clone https://github.com/marioparaschiv/sapphire-agent ~/sapphire-agent
    cd ~/sapphire-agent
    npm install
    ```

2. Install the `sapphire` CLI and the systemd unit:

    ```bash
    sh scripts/install.sh
    ```

3. Write `~/.config/sapphire-agent/config.json`, and put these secret files next to it with mode `600`:

    | File                    | Holds                                                     |
    | ----------------------- | --------------------------------------------------------- |
    | `linear-key`            | A Linear personal API key.                                |
    | `linear-webhook-secret` | The Linear webhook's signing secret.                      |
    | `app.pem`               | The GitHub App's private key.                             |
    | `webhook-secret`        | The GitHub App's webhook secret.                          |
    | `t3-token`              | A T3 session token. `scripts/mint-t3-token.sh` makes one. |

4. Start it:

    ```bash
    systemctl --user start sapphire-agent
    ```

The service checks the config and every secret before it starts. If anything is wrong, it lists all the problems in one error and exits.

### Usage

```bash
sapphire project add Unbound ~/unbound   # watch a Linear team
sapphire dispatch HL-14                  # start an epic now
sapphire status                          # runs, projects and queued commands
sapphire send HL-9 Use the existing helper.
sapphire pause                           # stop starting new runs
```

Logs: `journalctl --user -u sapphire-agent -f`.

## For Developers

### Developing Sapphire Agent

```bash
npm test            # vitest
npm run typecheck   # tsc
npm start           # run the service in the foreground
```

The tests run against fakes of Linear, GitHub and T3, so they never touch a live service.

### Architecture

The service is one level-triggered reconciler built on [Effect](https://effect.website). On each tick it reads Linear, git, GitHub and the runs' T3 threads, compares that with a small SQLite journal, and does at most one piece of work per epic. Every decision comes from the current state, so a missed webhook or a crash can't leave it out of sync.

| Path                        | Responsibility                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/reconciler.ts`         | The tick loop and what wakes it: the poll, webhooks, agent events, the CLI.                               |
| `src/observation.ts`        | Reads every outside system once per tick.                                                                 |
| `src/rules.ts`              | The rules, in order: requests, cleanup, results, monitoring, dispatch.                                    |
| `src/journal.ts`            | The SQLite journal of runs, claims, commands and requests.                                                |
| `src/webhook-server.ts`     | Signed GitHub and Linear webhook deliveries.                                                              |
| `src/agent-event-server.ts` | Hook events from the agents (Claude Code and Pi so far), and the guards that keep runs in their worktree. |
| `src/ctl.ts`                | The `sapphire` CLI.                                                                                       |
