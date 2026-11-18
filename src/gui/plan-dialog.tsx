/**
 * The "Plan" picker: choose the OpenCode project where the planning session
 * opens. It lists the projects the host already knows and accepts an absolute
 * path for a new one. The chosen directory becomes a repository of the
 * initiative and the item's repository, then the session starts there.
 */

import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { Context, ServerRef } from "@opencode/plugin/gui";
import { ErrorBanner, LoadingRow, SHARED_CSS } from "opencode-shared/gui";
import { PlansRpc, type WorkItemDetail } from "./contract";
import { DIALOG_SURFACE_CSS } from "./dialog-surface";
import { useT } from "./i18n";
import { planWorkItem } from "./plan-item";
import { repoForItem } from "../work-plan";
import planDialogCss from "./plan-dialog.scss?inline";

const CSS = planDialogCss;

export type PlanDialogInput = {
  ctx: Context;
  server: ServerRef;
  detail: WorkItemDetail;
  onPlanned?: (sessionID: string) => void;
};

/** Opens the host dialog (above the Work overlay) with the project picker. */
export function openPlanDialog(input: PlanDialogInput): void {
  input.ctx.dialogs.open((dialog) => <PlanDialog {...input} close={() => dialog.close()} />);
}

type HostProject = { id: string; name: string; directory: string };

function PlanDialog(props: PlanDialogInput & { close: () => void }) {
  const t = useT();
  let shell: HTMLDivElement | undefined;
  const [projects, setProjects] = createSignal<HostProject[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [query, setQuery] = createSignal("");
  const [manual, setManual] = createSignal("");
  const [selected, setSelected] = createSignal<string | undefined>(
    repoForItem(props.detail.initiative, props.detail.item.repoID ?? null)?.directory,
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // The host layer mounts raw dialog content with pointer-events: none; the
  // root opts back in, and the first field takes focus (no app Dialog Content).
  onMount(() => {
    queueMicrotask(() => {
      shell?.querySelector<HTMLInputElement>("input, textarea")?.focus();
    });
  });

  createEffect(() => {
    void props.server.client
      .project.list()
      .then((list) =>
        setProjects(
          (list ?? []).map((project) => ({
            id: project.id,
            name:
              project.name?.trim() ||
              project.canonical.split("/").filter(Boolean).pop() ||
              project.canonical,
            directory: project.canonical,
          })),
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  });

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return projects();
    return projects().filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.directory.toLowerCase().includes(needle),
    );
  });

  const chooseManual = () => {
    const path = manual().trim();
    if (!path) return;
    setSelected(path);
    setError(null);
  };

  const confirm = () => {
    const directory = selected()?.trim();
    if (!directory || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .ensureInitiativeRepo({ initiativeID: props.detail.initiative.id, directory })
      .then(async (ensured) => {
        if (!ensured.ok || !ensured.repo) {
          throw new Error(ensured.error ?? t("work.plan.repoError"));
        }
        const saved = await props.server.client
          .rpc(PlansRpc)
          .setWorkItemRepo({ id: props.detail.item.id, repoID: ensured.repo.id });
        if (!saved.ok) throw new Error(saved.error ?? t("work.plan.repoError"));
        const sessionID = await planWorkItem({
          ctx: props.ctx,
          target: { server: props.server },
          detail: props.detail,
          t,
          directory,
        });
        props.onPlanned?.(sessionID);
        props.close();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <style>{SHARED_CSS + DIALOG_SURFACE_CSS + CSS}</style>
      <div class="plan-dialog plans-dialog-surface" ref={shell}>
        <h2 class="plan-dialog-title">{t("work.plan.dialog.title", props.detail.item.title)}</h2>
        <p class="plan-dialog-hint">{t("work.plan.dialog.hint")}</p>

        <props.ctx.ui.TextInput
          value={query()}
          onInput={(value) => setQuery(value)}
          label={t("work.plan.dialog.search")}
          placeholder={t("work.plan.dialog.searchHint")}
        />

        <div class="plan-dialog-list" role="listbox" aria-label={t("work.plan.dialog.projects")}>
          <Show when={loading()}>
            <LoadingRow label={t("work.loading")} />
          </Show>
          <For each={filtered()}>
            {(project) => (
              <button
                type="button"
                class="plan-dialog-row"
                classList={{ "is-selected": selected() === project.directory }}
                role="option"
                aria-selected={selected() === project.directory}
                onClick={() => setSelected(project.directory)}
              >
                <span class="plan-dialog-row-name">{project.name}</span>
                <span class="plan-dialog-row-path">{project.directory}</span>
              </button>
            )}
          </For>
          <Show when={!loading() && filtered().length === 0}>
            <span class="plan-dialog-empty">{t("work.plan.dialog.empty")}</span>
          </Show>
        </div>

        <div class="plan-dialog-add">
          <props.ctx.ui.TextInput
            value={manual()}
            onInput={(value) => setManual(value)}
            onSubmit={chooseManual}
            label={t("work.plan.dialog.path")}
            placeholder={t("work.plan.dialog.pathHint")}
          />
          <props.ctx.ui.Button size="small" variant="neutral" icon="plus" disabled={!manual().trim()} onClick={chooseManual}>
            {t("work.plan.dialog.addPath")}
          </props.ctx.ui.Button>
        </div>

        <Show when={selected()}>
          {(directory) => <span class="plan-dialog-row-path">{t("work.plan.dialog.selected", directory())}</span>}
        </Show>

        <Show when={error()}>
          <ErrorBanner message={error()!} />
        </Show>

        <div class="plan-dialog-actions">
          <props.ctx.ui.Button size="small" variant="ghost" onClick={props.close}>
            {t("cancel")}
          </props.ctx.ui.Button>
          <props.ctx.ui.Button
            size="small"
            variant="contrast"
            busy={busy()}
            disabled={!selected() || busy()}
            onClick={confirm}
          >
            {t("work.plan")}
          </props.ctx.ui.Button>
        </div>
      </div>
    </>
  );
}
