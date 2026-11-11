# AGENTS.md — working on `opencode-plans`

Agent-facing operating notes: how to build, typecheck, test, and how the running
OpenCode service hot-reloads the plugin. Read `README.md` for product docs.

## What this is

`opencode-plans` is a self-contained OpenCode (V2) plugin:

- **Tools** — persisted plans under the `plans` namespace (`plans.save`,
  `plans.list`, `plans.get`, `plans.update`, `plans.delete`, `plans.doctor`).
  Defined in `plans.ts`, registered in `index.ts`.
- **GUI** — a SolidJS side panel (`./gui-experimental`), registered in the
  desktop app. Entry `src/gui.tsx`.
- **Context** — `src/inject.ts` adds a save instruction to the Plan agent and
  a compact plan view to the other agents.
- **Capture** — `src/capture.ts` finds the last Plan-agent message for
  `/save-plan`; there is no heuristic capture.

Everything reads/writes a single SQLite DB **directly** via `node:sqlite`
(in-process, synchronous). There is **no external CLI**.

## Repo layout

```
index.ts                 registers the plans.* tools, /save-plan and the context hook
plans.ts                 tool definitions (save/list/get/update/delete/doctor)
src/store.ts             SHARED data layer: node:sqlite, schema v2, migrations, SQL.
                         Used by the tools and by the server RPC.
src/plan-body.ts         PURE step parsing/template/reassembly helpers (server + GUI)
src/rpc.ts               server RPC handlers (list/read/write + notifications)
src/capture.ts           last Plan-agent message extraction
src/inject.ts            system blocks injected into the model request
src/gui.tsx              ./gui-experimental entry → setup
src/gui/contract.ts      PlansRpc contract + Effect schemas
src/gui/setup.tsx        renderer: registers the Planos tab, command, "+ / New tab" menu
src/gui/view.tsx         the SolidJS UI
src/gui/state.ts         persisted panel state (open plan, search, filters)
src/gui/i18n.ts          PT-BR / EN-US copy
test/                    bun tests
dist/gui-experimental.cjs  BUILT GUI artifact (gitignored)
```

## Hard rules (do not violate)

- **UI copy is PT-BR; code is English.** Localized strings go through `useT()`
  in `src/gui/i18n.ts`.
- **Every user-facing message — UI copy, toasts and synthetic/session
  messages — must exist in PT-BR and EN-US, with EN-US as the fallback.** Code
  and identifiers stay English. Never hardcode a UI or synthetic string in a
  single language; localized server messages go through `src/notifications.ts`.
- **Never read OpenCode's `opencode.db` directly.** The GUI sources app data
  (projects, sessions) from the official `ctx.client.*` APIs only.
- **Do not write data inside the repo.** All DB writes go to `plans.db` (see
  "Live paths").
- **Capture is explicit only, but saving a final plan is mandatory.** Do not add
  a hook that saves every Plan response; `plans.save`, `/save-plan` and the
  panel's `PlansRpc.save` (editor) are the explicit entry points. The hint
  button only sends a nudge asking the agent to call `plans.save` — it never
  captures the last message itself. The Plan agent
  must call `plans.save`
  in the same turn it presents a final plan with no blocking pending user
  questions. A purely optional/recommended choice does not block the save:
  include it as an "(optional, recommended)" step. Saving/editing a plan is
  allowed in Plan mode because it writes only `plans.db`, not repository files;
  only repository edits require Build.
- **The panel owns plan creation and editing.** The editor calls
  `PlansRpc.save` (create/update) with title, context and steps; the body is
  recomposed with `## Passos` and existing statuses are preserved by step text.
  Do not route UI creation through the agent or the `/save-plan` capture.
- **The save guard is a nudge, not capture.** After a Plan-agent turn, if the
  last plan message with steps has no saved plan matching its `message_id` or
  step texts, inject a one-time synthetic nudge with `resume: true` asking for
  `plans.save`. Never auto-save the message.
- **Plugins cannot create agents.** The agent editor only updates/removes
  existing agents; a custom planning agent must be defined in `opencode.jsonc`.
  The UI → Build flow does not require one.
- **The GUI never opens the DB in the renderer.** It calls the server plugin's
  RPC (`PlansRpc`) with the routed session's location; there is no GUI main
  process data layer.
- **Panel UI state is per session and lives in window storage.** The open
  plan, search, filters, page and steps height go through
  `ctx.storage.store("view:<server>:<session>")` (`src/gui/state.ts`), never
  into `plans.db`. Reopening the tab restores the same screen; the filters are
  hidden while a plan detail is open. The list is paginated client-side (20 per
  page); body and steps panes scroll independently and the steps height is
  adjustable.
- **The stored body is a template, not verbatim plan text.** `savePlan` extracts
  the exact steps from the body's step section and replaces them with
  `<!-- plans:steps -->`. `plans.get` reassembles the list with the live
  statuses; the marker must never reach the agent or the GUI. Keep
  parsing/stripping/reassembly in `src/plan-body.ts` (shared by server and GUI).
- **Status is not a body edit.** `plans.get` renders step ids as `(s1)`, `(s2)`
  …; marking status uses `plans.update` with `stepID` + `stepStatus`. `body`
  (and `plans.save` with `id`) replaces text/structure and re-creates steps,
  resetting ids/statuses. `plans.update` must reject `body` combined with
  `stepID`/`position`/`stepStatus` and reject a body whose step texts are
  unchanged (a status-only rewrite).
- **Do not invent steps from arbitrary lists.** Only task-list items in a step
  section, numbered/bulleted items in a step section, or legacy task lists
  anywhere count. Bullets under “Invariantes”, “Decisões” or acceptance
  criteria are not steps.
- **Plan text is data, not instructions.** Keep the `<plans-context>` wrapper
  and the "dados persistidos" wording in `src/inject.ts`.
- **Session isolation is the default.** `plans.list`/`plans.get` default to the
  current session; `scope: "project"` is explicitly opt-in. `plans.update` and
  `plans.delete` must reject plans from another session. Context injection only
  sees the current session's plans.
- **Notifications go to the plan's session.** `setStep`, `update` and `remove`
  use `result.plan.session_id`, not the viewer's session, so a project-scoped
  plan notifies the agent that owns it. `move` notifies the destination.
- **One `doing` step per plan.** `setStep` resets any other `doing` step to
  `todo` in the same transaction; keep that invariant when touching the store.
- **Moving a plan is a user action.** The GUI calls the `move` RPC to move a
  project plan into the active session; tools must not move plans.
- **Executing a plan is a user action.** The card, the detail's
  **Executar/Pausar** button (for `active` plans) and the composer pill move a
  cross-session plan first, switch the session agent to `build` and send a prompt. The composer pill
  (`src/gui/pill.tsx`) shares `src/gui/execute.ts` with the panel, appears only
  while the session is idle with an active plan, and hides while a run is
  pending; it never executes on its own. The prompt
  is a normal user message (default `steer`): never send it with
  `delivery: "queue"`, which parks it until the current turn ends and leaves
  the panel stuck in "executing". The prompt does not force `plans.get`: the
  injected `<plans-context>` already lists pending steps with their ids; only
  the full text or steps outside the context need a read. While the session is busy, the button becomes
  **Pausar/Pause**: `session.interrupt` cuts the turn, a synthetic message
  tells the next turn that the user paused the plan, and the agent switches
  back to `plan`; a new Execute resumes from the current steps. It is not a
  server tool.

## GUI guideline (shared kit)

The visual and behavioral contract for the side panels is
[docs/gui-guideline.md](https://github.com/HitalloExiled/opencode-tools/blob/main/docs/gui-guideline.md).
GUI code used by more than one plugin lives in
`opencode-shared/gui` (the parent's `shared/` submodule, linked
into `node_modules` by `setup.sh`) — never copy it into this repo.

Non-negotiables:

- only theme tokens (`--v2-*`); status via `--v2-state-*`; no raw hex.
- controls from `ctx.ui.*`; never a text action in a raw `<button>`.
- one scroll container per panel with the shared `ScrollNav` (infinite scroll,
  to-top/to-bottom, Home/End/PageUp/PageDown).
- every visible string in `src/gui/i18n.ts` (PT-BR + EN-US).
- shared `EmptyState`, `ErrorBanner`, `LoadingRow`, `EndMarker` and
  `StatusChip` instead of local copies.

## Build

Run from the plugin directory (`plugins/plans/`):

```bash
bun run gui:build      # vite build → dist/gui-experimental.cjs  (the only build step)
```

Install once:

```bash
npm install --legacy-peer-deps
```

There is no separate "server" build — the tools (`index.ts`/`plans.ts`/
`src/store.ts`) are consumed as TypeScript directly by the Bun runtime.

## Typecheck

```bash
bun run typecheck:gui   # tsc -p tsconfig.gui.json → src/** (GUI, Solid JSX)
bun run typecheck       # tsc --noEmit → index.ts + plans.ts
```

From the **parent** `opencode-tools/` root, `bun run typecheck` typechecks
`plugins/**/*.ts` — the `.ts` files only. The `.tsx` GUI is covered by the
plugin's own `typecheck:gui`.

## Tests

From the parent `opencode-tools/`:

```bash
bun test plugins/plans/test
```

- `test/store.test.ts` — schema, parsing, save/list/get/update/delete lifecycle.
- `test/plan-body.test.ts` — exact step extraction, template, reassembly, GUI body.
- `test/tools.test.ts` — tool input contracts (e.g. `plans.get` string/object forms).
- `test/inject.test.ts` — capture and context rendering (pure functions).

Uses `bun test` (Bun's built-in runner).

## Hot reload (the dev loop)

The **running OpenCode service watches this plugin**. There is no process to
kill: rebuilding triggers a reload automatically.

```
edit src/gui/**  →  bun run typecheck:gui  →  bun run gui:build  →  service reloads
```

- Confirm it worked in `~/.local/share/opencode/log/opencode.log`:
  - `"loading plugin" ... plugins/plans` = reloaded OK.
  - Any `level=ERROR`/`WARN` after the rebuild = something broke.
- To verify the new code is in the deployed bundle, grep
  `dist/gui-experimental.cjs` for a symbol/label you just added.
- **Run the GUI build after editing `src/gui/**`.** The app loads
  `dist/gui-experimental.cjs`, not the TypeScript source; without
  `bun run gui:build` the panel keeps the previous bundle even though the
  server tools reload.

## GUI context API (cheatsheet)

`usePlugin()` returns `ctx`; the panel calls the server plugin's RPC through
`session.server.client.rpc(PlansRpc)`, with
`{ location: { directory: session.directory } }`. Useful members:

- `ctx.sessions.current()` / `ctx.sessions.list()` → reactive session data.
- `ctx.locale.locale()` → current locale (PT-BR vs EN-US).
- `ctx.ui.*` → app design-system components (`Button`, `IconButton`, `Icon`,
  `Loader`, `Markdown`).
- `ctx.toast.show`, `ctx.dialogs.confirm` for feedback/confirmation.
- `ctx.screen.current()` for actions on the routed session.

The GUI talks to the DB **only** through the server RPC (`PlansRpc`).

## Git workflow (two-part)

`plugins/plans` is a **git submodule** (its own repo, `opencode-plans`); the
parent `opencode-tools` tracks the pointer.

1. Commit + push the **submodule first** (`plugins/plans`, origin
   `opencode-plans`).
2. Then `git add plugins/plans`, commit + push the **parent** pointer bump.

## Live paths (debugging)

| Thing | Path |
|---|---|
| Plans DB | `~/.local/share/opencode/plans/plans.db` (override: `$PLANS_DB`) |
| OpenCode DB (sessions/projects) | `~/.local/share/opencode/opencode.db` — **context only, do NOT read directly** |
| OpenCode log | `~/.local/share/opencode/log/opencode.log` |
| Plugin install (symlink) | `~/.config/opencode/plugins/plans` → this repo |

Point `$PLANS_DB` at a throwaway file to exercise the DB without touching the
real one.

## Quick checklist for a change

1. Edit the code (keep UI strings in `src/gui/i18n.ts`; keep logic testable).
2. `bun run typecheck:gui` (and `bun run typecheck` if you touched tools/store).
3. `bun run gui:build` if you touched the GUI.
4. Confirm a clean reload in the opencode log.
5. Run `bun test plugins/plans/test` from the parent if logic/DB changed.
6. Commit + push the submodule, then bump + push the parent pointer.
