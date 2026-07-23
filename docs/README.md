# PrepShip documentation map

Use this map to keep durable project knowledge discoverable without treating the
repository as storage for local AI sessions or generated output.

## Canonical project instructions

- [`../AGENTS.md`](../AGENTS.md) is the canonical instruction file for coding agents.
- [`../CLAUDE.md`](../CLAUDE.md) and [`../.cursorrules`](../.cursorrules) mirror
  `AGENTS.md` for tool compatibility; they are project rules, not AI memory.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) defines source-of-truth placement and
  verification requirements.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) defines contribution and PR evidence rules.

## Plans, tickets, and durable records

- [`ps-tickets/`](ps-tickets/) owns PS ticket packets, status records, reports, and the
  ticket ledger.
- [`superpowers/plans/`](superpowers/plans/) contains bounded implementation plans that
  remain useful across sessions.
- [`engineering/`](engineering/) contains engineering design notes and focused
  architecture plans.
- [`architecture-debt/`](architecture-debt/) contains measured architecture audits and
  the refactor backlog.
- [`reports/`](reports/) contains durable, reviewed project reports.

Several historical plans and audits remain at the repository root because guards and
other documents reference their exact paths. Examples include `PLAN.md`,
`DURABLE_JOBS_PLAN.md`, `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`,
`OBSERVABILITY_ALERTING_PLAN.md`, and `SECURITY_PATCH_PLAN.md`. Do not bulk-move these
files. Relocate one only when every reference and guard is updated and verified in the
same change.

For new work, prefer a PS ticket document or a bounded plan under the directories above
instead of creating another root-level plan.

## What belongs in Git

Commit a plan or audit when it is reviewed project knowledge: it defines an accepted
decision, an active ticket's scope and acceptance criteria, a production runbook, a
migration contract, or a durable verification record.

Do not commit local AI/session state, prompt/result logs, agent databases, lock files,
scratch regex scripts, temporary screenshots, or generated delivery output. Shared tool
configuration such as `.graphifyignore` may be committed deliberately when it benefits
every contributor; generated `graphify-out/` data must remain local.

Source assets that are referenced by documentation belong under `docs/assets/`.
Intermediate screenshots belong under the ignored `tmp/` directory. Generated PDFs and
other delivery artifacts belong under the ignored `output/` directory unless they are
explicitly promoted into a reviewed documentation or release location.
