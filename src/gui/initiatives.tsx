/**
 * The Initiative screen: every initiative the user has, with its repositories
 * and open work items. Opening one switches the overlay to Work scoped to it;
 * the only creation entry point lives here.
 */

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ServerRef } from "@opencode/plugin/gui";
import { usePlugin } from "@opencode/plugin/gui";
import { EmptyState, ErrorBanner, LoadingRow, SHARED_CSS } from "opencode-shared/gui";
import { PlansRpc, type Initiative, type WorkGroup } from "./contract";
import { useT } from "./i18n";
import { openInitiativeDialog } from "./initiative-dialog";

const CSS = `
.initiatives { display: flex; flex-direction: column; gap: 10px; width: 100%; height: 100%; min-height: 0; padding: 12px; box-sizing: border-box; overflow: hidden; color: var(--v2-text-text-base); font-size: 12.5px; }
.initiatives-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.initiatives-count { font-size: 11px; color: var(--v2-text-text-muted); }
.initiatives-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
.initiative-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
  cursor: pointer;
  text-align: left;
}
.initiative-card:hover { border-color: var(--v2-border-border-strong); background-image: linear-gradient(var(--v2-overlay-simple-overlay-hover), var(--v2-overlay-simple-overlay-hover)); }
.initiative-card:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
.initiative-name { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.initiative-description { font-size: 11.5px; color: var(--v2-text-text-muted); overflow-wrap: anywhere; }
.initiative-meta { display: flex; gap: 10px; font-size: 10.5px; color: var(--v2-text-text-faint); }
.initiative-overview-mark { padding: 0 4px; border: 1px solid var(--v2-border-border-muted); border-radius: 4px; color: var(--v2-text-text-muted); }
`;

export function InitiativesBody(props: {
  server: ServerRef;
  initiatives: Initiative[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onCreated: (initiative: Initiative) => void;
}) {
  const ctx = usePlugin();
  const t = useT();
  const [groups, setGroups] = createSignal<WorkGroup[]>([]);
  const [reload, setReload] = createSignal(0);

  createEffect(() => {
    void reload();
    void props.server.client
      .rpc(PlansRpc)
      .listWorkItems({ scope: "all" })
      .then((value) => setGroups(value as WorkGroup[]))
      .catch(() => undefined);
  });

  createEffect(() => {
    const off = props.server.client.rpc(PlansRpc).events.on("changed", () => {
      setReload((n) => n + 1);
    });
    onCleanup(off);
  });

  const itemCount = (id: string) =>
    groups().find((group) => group.initiative.id === id)?.items.length ?? 0;

  const create = () => {
    openInitiativeDialog({
      ctx,
      server: props.server,
      onCreated: (initiative) => {
        ctx.toast.show({ title: t("work.initiative.created"), variant: "success" });
        props.onCreated(initiative);
      },
    });
  };

  return (
    <>
      <style>{SHARED_CSS + CSS}</style>
      <div class="initiatives">
        <div class="initiatives-head">
          <span class="initiatives-count">
            {t("work.initiative.count", props.initiatives.length)}
          </span>
          <ctx.ui.Button size="small" variant="contrast" icon="plus" onClick={create}>
            {t("work.initiative.new")}
          </ctx.ui.Button>
        </div>

        <Show when={props.loading}>
          <LoadingRow label={t("work.loading")} />
        </Show>
        <Show when={!props.loading && props.error}>
          <ErrorBanner message={t("work.error")} />
        </Show>

        <Show when={!props.loading && !props.error}>
          <Show
            when={props.initiatives.length > 0}
            fallback={
              <EmptyState
                icon="workspace"
                title={t("work.initiative.emptyTitle")}
                hint={t("work.initiative.emptyHint")}
              />
            }
          >
            <div class="initiatives-list" role="list">
              <For each={props.initiatives}>
                {(initiative) => (
                  <div
                    class="initiative-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => props.onOpen(initiative.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onOpen(initiative.id);
                      }
                    }}
                  >
                    <span class="initiative-name">{initiative.name}</span>
                    <Show when={initiative.description}>
                      <span class="initiative-description">{initiative.description}</span>
                    </Show>
                    <span class="initiative-meta">
                      <Show when={initiative.overview}>
                        <span class="initiative-overview-mark">{t("work.initiative.overview")}</span>
                      </Show>
                      <span>{t("work.initiative.reposCount", initiative.repos.length)}</span>
                      <span>{t("work.initiative.itemsCount", itemCount(initiative.id))}</span>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
