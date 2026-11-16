/**
 * Create and manage initiatives. Creation needs only a name and an optional
 * description; repositories are managed afterwards (or added implicitly by the
 * plan picker). The dialog also renames/re-describes and adds, removes or
 * promotes repositories.
 */

import { createSignal, For, Show } from "solid-js";
import type { Context, ServerRef } from "@opencode/plugin/gui";
import { ErrorBanner, SHARED_CSS } from "opencode-shared/gui";
import { PlansRpc, type Initiative } from "./contract";
import { useT } from "./i18n";

const CSS = `
.initiative-dialog { display: flex; flex-direction: column; gap: 10px; width: min(560px, calc(100vw - 48px)); max-height: min(74vh, 620px); }
.initiative-dialog-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--v2-text-text-base); overflow-wrap: anywhere; }
.initiative-dialog-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 40px; padding-right: 2px; }
.initiative-dialog-row { display: flex; align-items: flex-end; gap: 6px; }
.initiative-dialog-row > :first-child { flex: 1; min-width: 0; }
.initiative-dialog-repo {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
  font-size: 11px;
  color: var(--v2-text-text-muted);
  overflow-wrap: anywhere;
}
.initiative-dialog-repo.is-primary { border-color: var(--v2-border-border-focus); }
.initiative-dialog-repo-path { flex: 1; min-width: 0; }
.initiative-dialog-actions { display: flex; justify-content: flex-end; gap: 6px; }
.initiative-dialog-hint { margin: 0; font-size: 11px; color: var(--v2-text-text-muted); }
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
  const [current, setCurrent] = createSignal<Initiative | undefined>(props.initiative);
  const [mode, setMode] = createSignal<"create" | "edit">(props.mode === "edit" && props.initiative ? "edit" : "create");
  const [name, setName] = createSignal(props.initiative?.name ?? "");
  const [description, setDescription] = createSignal(props.initiative?.description ?? "");
  const [newPath, setNewPath] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const create = () => {
    const title = name().trim();
    if (!title || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .createInitiative({ name: title, description: description().trim() || undefined })
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

  const replace = (initiative: Initiative) => {
    setCurrent(initiative);
    setMode("edit");
    setName(initiative.name);
    setDescription(initiative.description ?? "");
    props.onChanged(initiative, "updated");
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
      })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        replace(result.initiative);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const addRepo = () => {
    const value = current();
    const directory = newPath().trim();
    if (!value || !directory || busy()) return;
    if (!directory.startsWith("/")) {
      setError(t("work.initiative.invalidPath"));
      return;
    }
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .addInitiativeRepo({ initiativeID: value.id, directory })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        setNewPath("");
        replace(result.initiative);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const removeRepo = (repoID: string) => {
    const value = current();
    if (!value || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .removeInitiativeRepo({ initiativeID: value.id, repoID })
      .then(async (result) => {
        if (!result.ok && result.needsConfirmation) {
          const confirmed = await props.ctx.dialogs.confirm({
            title: t("work.initiative.removeTitle"),
            description: t("work.initiative.removeMessage", result.items ?? 0),
            confirm: t("work.initiative.removeConfirm"),
            cancel: t("cancel"),
            danger: true,
          });
          if (!confirmed) return;
          const retried = await props.server.client
            .rpc(PlansRpc)
            .removeInitiativeRepo({ initiativeID: value.id, repoID, confirm: true });
          if (!retried.ok || !retried.initiative) {
            setError(retried.error ?? t("work.initiative.error"));
            return;
          }
          replace(retried.initiative);
          return;
        }
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        replace(result.initiative);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const makePrimary = (repoID: string) => {
    const value = current();
    if (!value || busy()) return;
    setBusy(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .setInitiativePrimary({ initiativeID: value.id, repoID })
      .then((result) => {
        if (!result.ok || !result.initiative) {
          setError(result.error ?? t("work.initiative.error"));
          return;
        }
        replace(result.initiative);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <style>{SHARED_CSS + CSS}</style>
      <div class="initiative-dialog">
        <h2 class="initiative-dialog-title">
          {mode() === "edit" && current()
            ? t("work.initiative.editTitle", current()!.name)
            : t("work.initiative.createTitle")}
        </h2>

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

        <Show when={mode() === "edit" && current()}>
          {(initiative) => (
            <>
              <span class="initiative-dialog-hint">{t("work.initiative.repos")}</span>
              <div class="initiative-dialog-list">
                <For each={initiative().repos}>
                  {(repo) => (
                    <div class="initiative-dialog-repo" classList={{ "is-primary": repo.primary }}>
                      <span class="initiative-dialog-repo-path">{repo.directory}</span>
                      <Show
                        when={repo.primary}
                        fallback={
                          <props.ctx.ui.Button
                            size="small"
                            variant="ghost"
                            disabled={busy()}
                            onClick={() => makePrimary(repo.id)}
                          >
                            {t("work.initiative.makePrimary")}
                          </props.ctx.ui.Button>
                        }
                      >
                        <span class="initiative-dialog-hint">{t("work.initiative.primary")}</span>
                      </Show>
                      <props.ctx.ui.IconButton
                        icon="trash"
                        label={t("work.initiative.removeRepo")}
                        disabled={busy()}
                        onClick={() => removeRepo(repo.id)}
                      />
                    </div>
                  )}
                </For>
              </div>
              <div class="initiative-dialog-row">
                <props.ctx.ui.TextInput
                  value={newPath()}
                  onInput={(value) => setNewPath(value)}
                  onSubmit={addRepo}
                  label={t("work.initiative.repoPath")}
                  placeholder={t("work.initiative.repoPathHint")}
                />
                <props.ctx.ui.Button
                  size="small"
                  variant="neutral"
                  icon="plus"
                  disabled={!newPath().trim() || busy()}
                  onClick={addRepo}
                >
                  {t("work.initiative.addRepo")}
                </props.ctx.ui.Button>
              </div>
            </>
          )}
        </Show>

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
