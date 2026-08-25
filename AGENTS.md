## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` — one directory per feature, with `spec.md` and numbered issue files. See `docs-internal/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to themselves: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs-internal/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root + `docs-internal/adr/` for decision records. See `docs-internal/agents/domain.md`.

## Docs index

- [PRD-v3.md](PRD-v3.md) — the single project plan (requirements / milestones / technical design; §13.10 is the fix ledger). Read before changing scope or features.
- [docs-internal/HANDOFF.md](docs-internal/HANDOFF.md) — session handoff: current milestone status, resume reading order, next-milestone checklist. Read at session start.
- [docs-internal/DEVLOG.md](docs-internal/DEVLOG.md) — development log (reverse-chronological: per-round changes / decisions / issue closes). Read to see what recently changed.
- [docs-internal/tech-stack-record.md](docs-internal/tech-stack-record.md) — 技术栈记录（API 契约 / 技术选择 / 预留接口 / 技术债，按开发阶段倒序）。消费 comm/display 契约前必读。
- [docs-internal/迭代备忘录.md](docs-internal/迭代备忘录.md) — milestone decisions (scope / tech constraints / deferred-to-later). Read before starting or closing a milestone.
- [CONTEXT.md](CONTEXT.md) — domain glossary (PRD-v3 is authoritative; this is the vocabulary snapshot). Read when a term is unfamiliar.
- [docs-internal/adr/](docs-internal/adr/) — architecture decision records (0001 WezTerm single target). Read before revisiting an irreversible choice.
- [docs-internal/agents/engineering-gates.md](docs-internal/agents/engineering-gates.md) — 主板验证三道门（node --test / tsc --noEmit / grep 白名单），每张票的合入门槛。
