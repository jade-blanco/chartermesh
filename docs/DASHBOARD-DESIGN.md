# CharterMesh Dashboard Design Contract

Status: accepted for the first runnable vertical slice.

This document translates the action-centric operating model in
`PRODUCT-DESIGN.md` into a small, dependency-free local dashboard. The
dashboard is a projection of Control Plane state. It is never a second task
ledger and never mutates rows directly.

## Product intent

The first screen answers three questions:

1. What needs a human decision now?
2. What can a role or runner start or resume now?
3. What is waiting, why is it waiting, and what will make it visible again?

The server and the browser must use the same `DashboardProjection`, including
the actionable count. Waiting work remains visible but does not inflate that
count.

## Information architecture

- Today: summary, prioritized user actions, work table, selected-work
  inspector, and runtime health.
- Work: all work items using the same table and inspector.
- Approvals: immutable artifact review actions.
- Runs & schedules: reserved navigation entry for run history and future
  schedule projections.
- Organization: reserved navigation entry for OrgSpec and runtime bindings.
- Activity: recent append-only Control Plane events.

The first slice implements Today, work filtering, row inspection, and a
new-request dialog. Reserved entries are visibly disabled, not represented as
working links.

## Desktop composition

- 220 px left navigation rail.
- Flexible main canvas with a maximum readable width.
- 286 px inspector on the right.
- Header with `오늘의 운영` and the primary `새 요청` action.
- Four compact summary cards: actionable, human review, user input, failure.
- Main work table: status, task, owner, next action, updated time.
- Inspector: selected task identity, state, reason, next action, lineage, and
  wait details.
- Runtime band: model engine and managed-runner readiness without credentials
  or filesystem paths.

## Mobile composition

- Navigation becomes a compact top bar.
- Summary cards become a horizontal two-column grid.
- The table becomes stacked work cards.
- The inspector becomes a bottom drawer opened by selecting a work card.
- Primary actions remain at least 44 px high.

## Visual system

- Canvas: true white `#ffffff`.
- Subtle surface: `#f6f8fb`.
- Ink: `#121821`; secondary ink: `#5e6875`.
- Hairline border: `#dfe4ea`.
- Primary blue: `#0b63e6`; blue wash: `#eaf2ff`.
- Ready teal: `#0f8a78`; teal wash: `#e8f7f3`.
- Waiting amber: `#a96700`; amber wash: `#fff5df`.
- Failure red: `#b42318`; red wash: `#ffebe9`.
- Radius: 10 px for cards and controls, fully rounded status pills.
- Typography: system sans-serif stack; semibold labels; tabular numerals for
  counts and identifiers.
- Shadows are reserved for the dialog and mobile drawer. Structure otherwise
  comes from spacing and hairlines.

## Component inventory

- `AppShell`
- `NavigationRail`
- `PageHeader`
- `SummaryCard`
- `FilterBar`
- `WorkTable` / `WorkCardList`
- `StatusPill`
- `WorkInspector`
- `RuntimeBand`
- `NewRequestDialog`
- `EmptyState`
- `Toast`

## Interaction contract

- Selecting a row updates the inspector without navigation.
- Filters never change Control Plane state.
- Creating a request sends one JSON command with an idempotency key and then
  refreshes the server projection.
- Mutation failures are shown inline and never optimistically hidden.
- Disabled navigation clearly says `준비 중`.
- Keyboard users can open and close the request dialog, submit it, select a
  work row, and close the mobile inspector.
- Focus rings meet WCAG contrast expectations and status is never color-only.

## Copy contract

Primary Korean interface copy:

- `오늘의 운영`
- `지금 필요한 조치`
- `사람 검토`
- `사용자 입력`
- `실패`
- `새 요청`
- `전체`, `조치 필요`, `대기 중`, `완료`
- `다음 조치`
- `런타임 상태`
- `요청 제목`, `요청 설명`, `취소`, `요청 만들기`

Machine status values may remain English identifiers in secondary metadata,
but every status pill includes a Korean label.

## Security and privacy

- The dashboard listens on loopback only.
- The server validates `Host` and mutation `Origin`.
- Every mutation requires JSON, a per-process session token, an idempotency
  key, and a bounded request body.
- API responses never contain credentials, environment values, artifact
  filesystem paths, database paths, or the absolute project path.
- The dashboard cannot approve its own results through a model action.
