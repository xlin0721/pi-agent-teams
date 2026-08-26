# pi-agent-teams

**English** · [简体中文](README.zh-CN.md)

**Visible multi-agent orchestration for [pi](https://github.com/earendil-works/pi) — spawn role agents into real terminal panes, steer them mid-task, queue work, message between agents, and hold meetings. Every agent is visible and interactive.**

`pi-agent-teams` is a terminal-first extension that turns a single `pi` coding-agent session into an **agent teams workbench**. Unlike black-box subagents, every agent you spawn gets a **real terminal pane** — you can watch it work, type to it, and redirect it at any time.

---

## Why this exists

Community multi-agent tools (task managers, message relays) show agents as lists inside a chat UI. `pi-agent-teams` is different: **every agent runs in a real, visible, typeable terminal pane** — like having actual teammates on your screen.

| Capability | What you get |
|---|---|
| **Spawn** | `spawn_visible_agent` — dispatch a role agent (complete TUI, full tool access) into a new pane, immediately, without blocking your session |
| **Queue** | Spawn more than the concurrency limit — tasks queue automatically, no babysitting |
| **Steer** | `steer` — redirect a running agent mid-task ("switch to plan B"); delivered at round boundary |
| **Message** | `msg` — point-to-point and broadcast between agents (notice / directive) |
| **Resume** | `farm_resume` — recover an aborted task from its last conversation |
| **Meetings** | Broadcast an agenda → each agent replies a round → main synthesizes a summary |
| **Status panel** | `setWidget` panel with live task table: taskId / role / status / attempts / elapsed / **cost** |
| **Grid layout** | New panes split the largest pane for a balanced farm layout (M7) |
| **Cost panel** | Token usage → estimated cost per task (post-hoc, user-configurable pricing) |

---

## Quick start

### Prerequisites

| Requirement | Notes |
|---|---|
| macOS | WezTerm single-target (see ADR-0001) |
| [WezTerm](https://wezfurlong.org/wezterm/) | `wezterm cli` available |
| Node ≥ 22 | runs `.ts` directly (type-stripping), zero `node_modules` |
| TypeScript | global install for the type gate (`tsc -p tsconfig.json --noEmit`) |
| [pi](https://github.com/earendil-works/pi) 0.84.x | `pi` on PATH |

### Install

```bash
# 1. Sync the extension to pi's extensions dir
rsync -a --exclude='*.test.ts' \
  src/ ~/.pi/agent/extensions/pi-agent-teams/

# 2. wrapper.sh must match in all three places
diff assets/wrapper.sh ~/.pi/agent/extensions/pi-agent-teams/assets/wrapper.sh
diff assets/wrapper.sh ~/.pi-agent-teams/wrapper.sh

# 3. Restart the pi main session (or reload) — extension is now live
```

### Use

```text
You: spawn 3 agents in parallel — one product lead, one frontend lead, one backend lead.
     I'll keep chatting here while they work.

pi:  ✅ task 1a2b3c (product-lead) queued → running
     ✅ task 2b3c4d (frontend-lead) queued → running
     ✅ task 3c4d5e (backend-lead) queued → running
     (panes appear on the right, each showing its agent's live work)

You: (sees frontend lead going off-track) steer 2b3c4d — stick to the M7 scope, no reflow.

You: farm_status
     → 5-column table: taskId / role / status / attempts / elapsed
```

> 📖 Documentation in progress — a public usage/feature guide will be added under `docs/`.

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  main pi session (extension index.ts)                       │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │ task-core │ │ display   │ │ comm      │                 │
│  │ queue     │ │ wezterm   │ │ inbox     │                 │
│  │ states    │ │ cli       │ │ presence  │                 │
│  │ store     │ │ render    │ │ feed      │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│        │             │             │                       │
│  ┌─────┴─────────────┴─────────────┴──────────────────┐    │
│  │ ~/.pi-agent-teams/<wsId>/  (per-workspace)         │    │
│  │ tasks/ status/ sessions/ inbox/ usage/ ...         │    │
│  │ ~/.pi-agent-teams/  (global: pricing/config)       │    │
│  └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
        │ spawn / steer / msg / resume
        ▼
┌─────────────────────────────────────────────────────────────┐
│  agent panes (WezTerm)                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ role agent │ │ role agent │ │ worker     │              │
│  │ (TUI)      │ │ (TUI)      │ │ (B-form:   │              │
│  │            │ │            │ │  status    │              │
│  │            │ │            │ │  window +  │              │
│  │            │ │            │ │  headless  │              │
│  │            │ │            │ │  pi -p)    │              │
│  └────────────┘ └────────────┘ └────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

- **task-core/** — pure state machine + queue + resume + schedule logic (zero deps)
- **display/** — WezTerm CLI primitives + terminal renderer (B-form worker windows)
- **comm/** — file-channel messaging: inbox / presence / feed
- **farm/** — orchestration loop: spawn, notify (`farm.done`), GC, mini-farm (depth ≥ 2)
- **probe.ts / steer-tool.ts** — capability probing, degradation chain, steer/msg/resume tools
- **assets/wrapper.sh** — pane-side lifecycle process (env-only contract, single writer)

### Key invariants

- **Workspace isolation** — each project (cwd) gets its own farm root `~/.pi-agent-teams/<workspaceId>/`; global config (`pricing.json`/`config.json`) stays at `~/.pi-agent-teams/`
- **Zero third-party deps** — no `package.json`, `node_modules`, or pi SDK imports outside `index.ts` (the only runtime boundary)
- **Single-writer matrix** — task files: the owning queue; done/aborted: the wrapper; usage sidecar: the wrapper; inbox: sender; presence: each pane process
- **WezTerm-only** — macOS single target; graceful degradation (L0/L1/L2) when the environment is unavailable

---

## Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary (Chinese)

> 📖 Documentation in progress — a public usage/feature guide will be added under `docs/`.

---

## Status

- M0–M7 complete: task-core → background mode → B-form worker windows → command (steer/msg/resume/panel) → meetings → grid + cost + distribution docs
- Workspace isolation (C1) + delivery-side depth filtering (C9): per-workspace farm roots (`~/.pi-agent-teams/<wsId>/`), meeting broadcasts exclude depth-2 workers, read-side depthCap defense
- 629 unit tests green, `tsc` zero errors, grep whitelist gates pass
- M5 (session-level scheduling) / M6 (system-level scheduling) deferred by decision

## License

TBD — ask the maintainer.
