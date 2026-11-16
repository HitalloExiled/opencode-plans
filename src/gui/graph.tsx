/**
 * The dependency graph: dependencies on the left, the items that wait for
 * them on the right. Drag from a node's + handle to another node to add an
 * explicit dependency; click a solid edge to remove it. Implicit edges (shared
 * footprint) are dashed and read-only.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ServerRef } from "@opencode/plugin/gui";
import { usePlugin } from "@opencode/plugin/gui";
import { EmptyState, ErrorBanner, LoadingRow, SHARED_CSS, StatusChip, type ChipTone } from "opencode-shared/gui";
import { PlansRpc, type WorkGraph, type WorkGraphEdge } from "./contract";
import { useT } from "./i18n";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  layoutWorkGraph,
  type GraphPlacement,
} from "../work-graph";

const CSS = `
.work-graph { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; }
.work-graph.is-panning { cursor: grabbing; }
.work-graph-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.work-graph-edges { position: absolute; top: 0; left: 0; overflow: visible; }
.work-graph-edge { fill: none; stroke: var(--v2-text-text-faint); stroke-width: 1.5; pointer-events: none; }
.work-graph-edge.is-implicit { stroke-dasharray: 4 4; stroke: var(--v2-state-fg-warning); opacity: 0.7; }
.work-graph-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; }
.work-graph-arrow { fill: var(--v2-text-text-faint); }
.work-graph-node {
  position: absolute;
  width: ${GRAPH_NODE_WIDTH}px;
  height: ${GRAPH_NODE_HEIGHT}px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--v2-border-border-muted);
  border-radius: 6px;
  background: var(--v2-background-bg-layer-01);
  cursor: pointer;
}
.work-graph-node:hover { border-color: var(--v2-border-border-strong); }
.work-graph-node-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--v2-text-text-base);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.work-graph-node-meta { display: flex; align-items: center; gap: 6px; margin-top: auto; }
.work-graph-progress { font-size: 10px; color: var(--v2-text-text-faint); font-variant-numeric: tabular-nums; }
.work-graph-handle {
  position: absolute;
  right: -9px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid var(--v2-border-border-strong);
  background: var(--v2-background-bg-layer-01);
  color: var(--v2-text-text-muted);
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  cursor: crosshair;
  user-select: none;
}
.work-graph-handle:hover { color: var(--v2-text-text-base); border-color: var(--v2-border-border-focus); }
.work-graph-ghost { stroke: var(--v2-border-border-focus); stroke-width: 1.5; stroke-dasharray: 3 3; pointer-events: none; }
.work-graph-controls { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; z-index: 1; }
.work-graph-legend { position: absolute; left: 6px; bottom: 6px; display: flex; gap: 10px; align-items: center; font-size: 10px; color: var(--v2-text-text-faint); z-index: 1; }
.work-graph-legend-line { display: inline-block; width: 18px; border-top: 1.5px solid var(--v2-text-text-faint); vertical-align: middle; }
.work-graph-legend-line.is-implicit { border-top-style: dashed; border-top-color: var(--v2-state-fg-warning); }
.work-graph-hint { position: absolute; left: 6px; top: 6px; font-size: 10px; color: var(--v2-text-text-faint); z-index: 1; }
`;

const statusTone = (status: string): ChipTone =>
  status === "doing"
    ? "info"
    : status === "ready" || status === "done"
      ? "success"
      : status === "blocked"
        ? "danger"
        : "neutral";

export function WorkGraph(props: {
  server: ServerRef;
  initiativeID: string | undefined;
  /** Bumped by the surface when something changed outside the graph. */
  revision: number;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const ctx = usePlugin();
  const [graph, setGraph] = createSignal<WorkGraph | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [linking, setLinking] = createSignal<{ from: string; x: number; y: number } | null>(null);
  const [panning, setPanning] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  let container: HTMLDivElement | undefined;

  createEffect(() => {
    const initiativeID = props.initiativeID;
    void props.revision;
    if (!initiativeID) {
      setGraph(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void props.server.client
      .rpc(PlansRpc)
      .getWorkGraph({ initiativeID })
      .then((value) => setGraph(value as WorkGraph))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  });

  const layout = createMemo(() => {
    const current = graph();
    if (!current) return undefined;
    return layoutWorkGraph(current.nodes, current.edges);
  });

  const placements = createMemo(() => {
    const map = new Map<string, GraphPlacement>();
    for (const placement of layout()?.placements ?? []) map.set(placement.id, placement);
    return map;
  });

  const edgePath = (edge: WorkGraphEdge): string | undefined => {
    const from = placements().get(edge.itemID);
    const to = placements().get(edge.blocksID);
    if (!from || !to) return undefined;
    const x1 = from.x;
    const y1 = from.y + GRAPH_NODE_HEIGHT / 2;
    const x2 = to.x + GRAPH_NODE_WIDTH;
    const y2 = to.y + GRAPH_NODE_HEIGHT / 2;
    const bend = Math.max(30, Math.abs(x1 - x2) / 2);
    return `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`;
  };

  const moveLink = (event: PointerEvent) => {
    const current = linking();
    if (!current || !container) return;
    const rect = container.getBoundingClientRect();
    const x = (event.clientX - rect.left - tx()) / scale();
    const y = (event.clientY - rect.top - ty()) / scale();
    setLinking({ ...current, x, y });
  };

  const endLink = (event: PointerEvent) => {
    window.removeEventListener("pointermove", moveLink);
    const current = linking();
    setLinking(null);
    if (!current) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-item-id]")
      ?.getAttribute("data-item-id");
    if (!target || target === current.from) return;
    void props.server.client
      .rpc(PlansRpc)
      .addWorkItemDep({ itemID: current.from, blocksID: target })
      .then((result) => {
        if (!result.ok) {
          setNotice(result.error ?? t("work.graph.addError"));
          return;
        }
        setNotice(null);
        void props.server.client
          .rpc(PlansRpc)
          .getWorkGraph({ initiativeID: props.initiativeID! })
          .then((value) => setGraph(value as WorkGraph));
      })
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)));
  };

  const startLink = (event: PointerEvent, nodeID: string) => {
    event.preventDefault();
    event.stopPropagation();
    const placement = placements().get(nodeID);
    if (!placement) return;
    setNotice(null);
    setLinking({
      from: nodeID,
      x: placement.x + GRAPH_NODE_WIDTH,
      y: placement.y + GRAPH_NODE_HEIGHT / 2,
    });
    window.addEventListener("pointermove", moveLink);
    window.addEventListener("pointerup", endLink, { once: true });
  };

  onCleanup(() => {
    window.removeEventListener("pointermove", moveLink);
    window.removeEventListener("pointerup", endLink);
  });

  const removeEdge = async (edge: WorkGraphEdge) => {
    if (edge.kind !== "explicit") return;
    const confirmed = await ctx.dialogs.confirm({
      title: t("work.graph.removeTitle"),
      description: t("work.graph.removeMessage"),
      confirm: t("work.graph.removeConfirm"),
      cancel: t("cancel"),
      danger: true,
    });
    if (!confirmed) return;
    void props.server.client
      .rpc(PlansRpc)
      .removeWorkItemDep({ itemID: edge.itemID, blocksID: edge.blocksID })
      .then((result) => {
        if (!result.ok) {
          setNotice(result.error ?? t("work.graph.removeError"));
          return;
        }
        void props.server.client
          .rpc(PlansRpc)
          .getWorkGraph({ initiativeID: props.initiativeID! })
          .then((value) => setGraph(value as WorkGraph));
      })
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)));
  };

  const fit = () => {
    const current = layout();
    if (!current || !container) return;
    const width = container.clientWidth - 24;
    const height = container.clientHeight - 24;
    const next = Math.min(1, width / current.width, height / current.height);
    setScale(Math.max(0.35, next));
    setTx(0);
    setTy(0);
  };

  // Fit once per loaded graph so a wide graph is visible without hunting.
  createEffect(() => {
    if (graph() && container) fit();
  });

  let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest("[data-item-id], .work-graph-controls")) return;
    panStart = { x: event.clientX, y: event.clientY, tx: tx(), ty: ty() };
    setPanning(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!panStart) return;
    setTx(panStart.tx + event.clientX - panStart.x);
    setTy(panStart.ty + event.clientY - panStart.y);
  };
  const onPointerUp = () => {
    panStart = null;
    setPanning(false);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    setScale((value) => Math.min(1.8, Math.max(0.35, value - event.deltaY * 0.001)));
  };

  return (
    <>
      <style>{SHARED_CSS + CSS}</style>
      <Show
        when={props.initiativeID}
        fallback={<EmptyState icon="workspace" title={t("work.graph.select")} hint={t("work.graph.selectHint")} />}
      >
        <Show when={loading()}>
          <LoadingRow label={t("work.loading")} />
        </Show>
        <Show when={!loading() && error()}>
          <ErrorBanner message={t("work.error")} retryLabel={t("work.retry")} />
        </Show>
        <Show when={!loading() && !error() && graph()}>
          {(current) => (
            <Show
              when={current().nodes.length > 0}
              fallback={<EmptyState icon="workspace" title={t("work.graph.empty")} hint={t("work.graph.emptyHint")} />}
            >
              <div
                ref={container}
                class="work-graph"
                classList={{ "is-panning": panning() }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                onWheel={onWheel}
                role="region"
                aria-label={t("work.graph.region")}
              >
                <span class="work-graph-hint">{t("work.graph.hint")}</span>
                <div class="work-graph-controls">
                  <ctx.ui.IconButton icon="plus" label={t("work.graph.zoomIn")} onClick={() => setScale((v) => Math.min(1.8, v + 0.1))} />
                  <ctx.ui.IconButton icon="minus" label={t("work.graph.zoomOut")} onClick={() => setScale((v) => Math.max(0.35, v - 0.1))} />
                  <ctx.ui.Button size="small" variant="ghost" onClick={fit}>
                    {t("work.graph.fit")}
                  </ctx.ui.Button>
                </div>
                <Show when={notice()}>
                  <div class="work-graph-hint" style={{ top: "28px", color: "var(--v2-state-fg-danger)" }}>
                    {notice()}
                  </div>
                </Show>
                <div
                  class="work-graph-canvas"
                  style={{
                    width: `${layout()?.width ?? 0}px`,
                    height: `${layout()?.height ?? 0}px`,
                    transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})`,
                  }}
                >
                  <svg class="work-graph-edges" width={layout()?.width ?? 0} height={layout()?.height ?? 0}>
                    <defs>
                      <marker
                        id="work-graph-arrow"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 0 L 10 5 L 0 10 z" class="work-graph-arrow" />
                      </marker>
                    </defs>
                    <For each={current().edges}>
                      {(edge) => {
                        const path = edgePath(edge);
                        return (
                          <Show when={path}>
                            {(value) => (
                              <>
                                <path class={`work-graph-edge is-${edge.kind}`} d={value()} marker-end="url(#work-graph-arrow)">
                                  <Show when={edge.reason}>
                                    <title>{edge.reason}</title>
                                  </Show>
                                </path>
                                <Show when={edge.kind === "explicit"}>
                                  <path class="work-graph-hit" d={value()} onClick={() => void removeEdge(edge)}>
                                    <title>{t("work.graph.removeHint")}</title>
                                  </path>
                                </Show>
                              </>
                            )}
                          </Show>
                        );
                      }}
                    </For>
                    <Show when={linking()}>
                      {(current_) => {
                        const from = placements().get(current_().from);
                        return (
                          <Show when={from}>
                            {(placement) => (
                              <line
                                class="work-graph-ghost"
                                x1={placement().x + GRAPH_NODE_WIDTH}
                                y1={placement().y + GRAPH_NODE_HEIGHT / 2}
                                x2={current_().x}
                                y2={current_().y}
                              />
                            )}
                          </Show>
                        );
                      }}
                    </Show>
                  </svg>
                  <For each={current().nodes}>
                    {(node) => (
                      <Show when={placements().get(node.id)}>
                        {(placement) => (
                          <div
                            class="work-graph-node"
                            data-item-id={node.id}
                            style={{ left: `${placement().x}px`, top: `${placement().y}px` }}
                            role="button"
                            tabIndex={0}
                            onClick={() => props.onOpen(node.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                props.onOpen(node.id);
                              }
                            }}
                          >
                            <span class="work-graph-node-title">{node.title}</span>
                            <span class="work-graph-node-meta">
                              <StatusChip tone={statusTone(node.status)} label={t(`work.status.${node.status}`)} />
                              <Show when={node.plan}>
                                {(plan) => (
                                  <span class="work-graph-progress">
                                    {plan().done}/{plan().total}
                                  </span>
                                )}
                              </Show>
                            </span>
                            <span
                              class="work-graph-handle"
                              role="button"
                              aria-label={t("work.graph.handle", node.title)}
                              onPointerDown={(event) => startLink(event, node.id)}
                            >
                              +
                            </span>
                          </div>
                        )}
                      </Show>
                    )}
                  </For>
                </div>
                <div class="work-graph-legend">
                  <span class="work-graph-legend-line" /> {t("work.graph.explicit")}
                  <span class="work-graph-legend-line is-implicit" /> {t("work.graph.implicit")}
                </div>
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </>
  );
}
