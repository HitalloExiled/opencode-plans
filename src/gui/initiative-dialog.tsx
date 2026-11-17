/**
 * Create and edit an initiative: name plus an optional description. The
 * repositories are not managed here — the Plan picker associates them (and
 * adds one to the initiative when needed).
 */

import { createSignal, onMount, Show } from "solid-js";
import type { Context, ServerRef } from "@opencode/plugin/gui";
import { ErrorBanner, SHARED_CSS } from "opencode-shared/gui";
import { PlansRpc, type Initiative } from "./contract";
import { DIALOG_SURFACE_CSS } from "./dialog-surface";
import { useT } from "./i18n";

const CSS = `
.initiative-dialog { display: flex; flex-direction: column; gap: 10px; width: min(560px, calc(100vw - 48px)); pointer-events: auto; }
.initiative-dialog-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--v2-text-text-base); overflow-wrap: anywhere; }
.initiative-dialog-actions { display: flex; justify-content: flex-end; gap: 6px; }
.initiative-dialog-hint { margin: 0; font-size: 11px; color: var(--v2-text-text-muted); }
.initiative-dialog-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--v2-text-text-muted); }
.initiative-dialog-field textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 150px;
  resize: vertical;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-layer-01);
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  padding: 8px;
}
.initiative-dialog-field textarea:focus { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
`;

export type InitiativeDialogInput = {
  ctx: Context;
  server: ServerRef;
  mode: "create" | "edit";
  initiative?: Initiative | undefined;
  onChanged: (initiative: Initiative, action: "created" | "updated") => void;
};

export function openInitiativeDialog(input: InitiativeDialogInput): void {
  input.ctx.dialogs.open((dialog) => <InitiativeDialog {...input} close={() => dialog.close()} />);
}

function InitiativeDialog(props: InitiativeDialogInput & { close: () => void }) {
  const t = useT();
  let shell: HTMLDivElement | undefined;
  const [current, setCurrent] = createSignal<Initiative | undefined>(props.initiative);
  const [mode, setMode] = createSignal<"create" | "edit">(props.mode === "edit" && props.initiative ? "edit" : "create");
  const [name, setName] = createSignal(props.initiative?.name ?? "");
  const [description, setDescription] = createSignal(props.initiative?.description ?? "");
  const [overview, setOverview] = createSignal(props.initiative?.overview ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // The host layer mounts raw dialog content with pointer-events: none; the
  // root opts back in, and the name field takes focus (no app Dialog Content).
  onMount(() => {
    queueMicrotask(() => {
      shell?.querySelector<HTMLInputElement>("input, textarea")?.focus();
    });
  });

  const create = () => {
    const title = name().trim();
    if (!title || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .createInitiative({ name: title, description: description().trim() || undefined, overview: overview().trim() || undefined })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        props.onChanged(result.initiative, "created");
        props.close();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const save = () => {
    const value = current();
    const title = name().trim();
    if (!value || !title || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .updateInitiative({
        id: value.id,
        name: title,
        description: description().trim() || null,
        overview: overview().trim() || null,
      })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        setCurrent(result.initiative);
        setMode("edit");
        setName(result.initiative.name);
        setDescription(result.initiative.description ?? "");
        setOverview(result.initiative.overview ?? "");
        props.onChanged(result.initiative, "updated");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <style>{SHARED_CSS + DIALOG_SURFACE_CSS + CSS}</style>
      <div class="initiative-dialog plans-dialog-surface" ref={shell}>
        <h2 class="initiative-dialog-title">
          {mode() === "edit" && current()
            ? t("work.initiative.editTitle", current()!.name)
            : t("work.initiative.createTitle")}
        </h2>

        <Show when={current()}>
          {(value) => (
            <span class="initiative-dialog-hint" title={value().id}>
              {t("work.initiative.id", value().id.slice(0, 8))}
            </span>
          )}
        </Show>

        <props.ctx.ui.TextInput
          value={name()}
          onInput={(value) => setName(value)}
          label={t("work.initiative.name")}
          placeholder={t("work.initiative.nameHint")}
          onSubmit={() => (mode() === "edit" ? save() : create())}
        />

        <props.ctx.ui.TextInput
          value={description()}
          onInput={(value) => setDescription(value)}
          label={t("work.initiative.description")}
          placeholder={t("work.initiative.descriptionHint")}
          onSubmit={() => (mode() === "edit" ? save() : create())}
        />

        <label class="initiative-dialog-field">
          <span>{t("work.initiative.overview")}</span>
          <textarea
            value={overview()}
            aria-label={t("work.initiative.overview")}
            placeholder={t("work.initiative.overviewHint")}
            onInput={(event) => setOverview(event.currentTarget.value)}
          />
        </label>
        <p class="initiative-dialog-hint">{t("work.initiative.overviewNote")}</p>

        <p class="initiative-dialog-hint">{t("work.initiative.reposHint")}</p>

        <Show when={error()}>
          <ErrorBanner message={error()!} />
        </Show>

        <div class="initiative-dialog-actions">
          <props.ctx.ui.Button size="small" variant="ghost" onClick={props.close}>
            {t("cancel")}
          </props.ctx.ui.Button>
          <Show when={mode() === "create"}>
            <props.ctx.ui.Button
              size="small"
              variant="contrast"
              busy={busy()}
              disabled={busy() || !name().trim()}
              onClick={create}
            >
              {t("work.initiative.create")}
            </props.ctx.ui.Button>
          </Show>
          <Show when={mode() === "edit"}>
            <props.ctx.ui.Button size="small" variant="contrast" busy={busy()} disabled={busy() || !name().trim()} onClick={save}>
              {t("work.initiative.save")}
            </props.ctx.ui.Button>
          </Show>
        </div>
      </div>
    </>
  );
}
