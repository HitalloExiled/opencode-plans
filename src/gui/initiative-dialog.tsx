/**
 * Create an initiative: name plus an optional description. Editing lives on the
 * Work detail (Itens | Visão geral | Ajustes); the repositories are born from
 * the Plan picker.
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
`;

export type InitiativeDialogInput = {
  ctx: Context;
  server: ServerRef;
  onCreated: (initiative: Initiative) => void;
};

export function openInitiativeDialog(input: InitiativeDialogInput): void {
  input.ctx.dialogs.open((dialog) => <InitiativeDialog {...input} close={() => dialog.close()} />);
}

function InitiativeDialog(props: InitiativeDialogInput & { close: () => void }) {
  const t = useT();
  let shell: HTMLDivElement | undefined;
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // The host layer mounts raw dialog content with pointer-events: none; the
  // root opts back in, and the name field takes focus (no app Dialog Content).
  onMount(() => {
    queueMicrotask(() => {
      shell?.querySelector<HTMLInputElement>("input")?.focus();
    });
  });

  const create = () => {
    const title = name().trim();
    if (!title || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .createInitiative({ name: title })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        props.onCreated(result.initiative);
        props.close();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <style>{SHARED_CSS + DIALOG_SURFACE_CSS + CSS}</style>
      <div class="initiative-dialog plans-dialog-surface" ref={shell}>
        <h2 class="initiative-dialog-title">{t("work.initiative.createTitle")}</h2>

        <props.ctx.ui.TextInput
          value={name()}
          onInput={(value) => setName(value)}
          label={t("work.initiative.name")}
          placeholder={t("work.initiative.nameHint")}
          onSubmit={create}
        />

        <p class="initiative-dialog-hint">{t("work.initiative.reposHint")}</p>

        <Show when={error()}>
          <ErrorBanner message={error()!} />
        </Show>

        <div class="initiative-dialog-actions">
          <props.ctx.ui.Button size="small" variant="ghost" onClick={props.close}>
            {t("cancel")}
          </props.ctx.ui.Button>
          <props.ctx.ui.Button
            size="small"
            variant="contrast"
            busy={busy()}
            disabled={busy() || !name().trim()}
            onClick={create}
          >
            {t("work.initiative.create")}
          </props.ctx.ui.Button>
        </div>
      </div>
    </>
  );
}
