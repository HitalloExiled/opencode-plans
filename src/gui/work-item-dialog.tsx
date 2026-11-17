/**
 * Work item registration: title and need. The item is created in the selected
 * initiative without a repository; the Plan picker associates one later.
 */

import { createSignal, onMount } from "solid-js";
import type { Context, ServerRef } from "@opencode/plugin/gui";
import { ErrorBanner, SHARED_CSS } from "opencode-shared/gui";
import { PlansRpc, type Initiative, type WorkItem } from "./contract";
import { DIALOG_SURFACE_CSS } from "./dialog-surface";
import { useT } from "./i18n";

const CSS = `
.work-item-dialog { display: flex; flex-direction: column; gap: 10px; width: min(600px, calc(100vw - 48px)); pointer-events: auto; }
.work-item-dialog-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--v2-text-text-base); overflow-wrap: anywhere; }
.work-item-dialog textarea {
  min-height: 160px;
  resize: vertical;
  font: inherit;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-layer-01);
  border: 1px solid var(--v2-border-border-strong);
  border-radius: 6px;
  padding: 8px;
}
.work-item-dialog-actions { display: flex; justify-content: flex-end; gap: 6px; }
.work-item-dialog-hint { margin: 0; font-size: 11px; color: var(--v2-text-text-muted); }
`;

export type WorkItemDialogInput = {
  ctx: Context;
  server: ServerRef;
  initiative: Initiative;
  onCreated: (item: WorkItem) => void;
};

export function openWorkItemDialog(input: WorkItemDialogInput): void {
  input.ctx.dialogs.open((dialog) => <WorkItemDialog {...input} close={() => dialog.close()} />);
}

function WorkItemDialog(props: WorkItemDialogInput & { close: () => void }) {
  const t = useT();
  let shell: HTMLDivElement | undefined;
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Raw dialog content: the root opts back into pointer events and the title
  // takes focus (the host layer mounts it with neither).
  onMount(() => {
    queueMicrotask(() => {
      shell?.querySelector<HTMLInputElement>("input, textarea")?.focus();
    });
  });

  const create = () => {
    const value = title().trim();
    if (!value || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .saveWorkItem({ initiativeID: props.initiative.id, title: value, body: body() })
      .then((result) => {
        if (!result.ok || !result.item) {
          setError(result.error ?? t("work.create.error"));
          return;
        }
        props.onCreated(result.item);
        props.close();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <style>{SHARED_CSS + DIALOG_SURFACE_CSS + CSS}</style>
      <div class="work-item-dialog plans-dialog-surface" ref={shell}>
        <h2 class="work-item-dialog-title">{t("work.newItem")}</h2>

        <props.ctx.ui.TextInput
          value={title()}
          onInput={(value) => setTitle(value)}
          onSubmit={create}
          label={t("work.detail.title")}
          placeholder={t("work.newItem.placeholder")}
        />

        <span class="work-item-dialog-hint">{t("work.detail.body")}</span>
        <textarea
          value={body()}
          aria-label={t("work.detail.body")}
          placeholder={t("work.detail.bodyHint")}
          onInput={(event) => setBody(event.currentTarget.value)}
        />

        <p class="work-item-dialog-hint">{t("work.newItem.hint")}</p>

        {error() && <ErrorBanner message={error()!} />}

        <div class="work-item-dialog-actions">
          <props.ctx.ui.Button size="small" variant="ghost" onClick={props.close}>
            {t("cancel")}
          </props.ctx.ui.Button>
          <props.ctx.ui.Button
            size="small"
            variant="contrast"
            busy={busy()}
            disabled={busy() || !title().trim()}
            onClick={create}
          >
            {t("work.newItem.add")}
          </props.ctx.ui.Button>
        </div>
      </div>
    </>
  );
}
