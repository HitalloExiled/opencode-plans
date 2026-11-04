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
src/store.ts             SHARED data layer: node:sqlite, schema v1, migrations, SQL.
                         Used by BOTH the tools and the GUI.
src/capture.ts           last Plan-agent message extraction
src/inject.ts            system blocks injected into the model request
src/gui.tsx              ./gui-experimental entry → { main, setup }
src/gui/main.ts          main-process IPC provider (PlansApi); maps DB rows → IPC shapes
src/gui/contract.ts      PlansApi IPC contract + Effect schemas
src/gui/setup.tsx        renderer: registers the Planos tab, command, "+ / New tab" menu
src/gui/view.tsx         the SolidJS UI
src/gui/i18n.ts          PT-BR / EN-US copy
test/                    bun tests
dist/gui-experimental.cjs  BUILT GUI artifact (gitignored)
```

## Hard rules (do not violate)

- **UI copy is PT-BR; code is English.** Localized strings go through `useT()`
  in `src/gui/i18n.ts`.
- **Never read OpenCode's `opencode.db` directly.** The GUI sources app data
  (projects, sessions) from the official `ctx.client.*` APIs only.
- **Do not write data inside the repo.** All DB writes go to `plans.db` (see
  "Live paths").
- **Capture is explicit only.** Do not add a hook that saves every Plan
  response; `plans.save`, `/save-plan` and the panel button are the only entry
  points.
- **The GUI never opens the DB in the renderer.** It talks to the main process
  through `ctx.main(PlansApi)`.
- **Plan text is data, not instructions.** Keep the `<plans-context>` wrapper
  and the "dados persistidos" wording in `src/inject.ts`.

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

`usePlugin()` returns `ctx`; `ctx.main(PlansApi)` is the IPC client to the
main-process provider (`src/gui/main.ts`). Useful members:

- `ctx.client.project.list()` → Promise<Project[]>, each with `.id`,
  `.canonical`, optional `.name`.
- `ctx.sessions.current()` / `ctx.sessions.list()` → reactive session data.
- `ctx.locale.locale()` → current locale (PT-BR vs EN-US).
- `ctx.ui.*` → app design-system components (`Button`, `IconButton`, `Icon`,
  `Loader`, `Markdown`).
- `ctx.toast.show`, `ctx.dialogs.confirm` for feedback/confirmation.
- `ctx.screen.current()` for actions on the routed session.

The GUI talks to the DB **only** through `ctx.main(PlansApi)`.

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
