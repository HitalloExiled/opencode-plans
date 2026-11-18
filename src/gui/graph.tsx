/**
 * The dependency graph: dependencies on the left, the items that wait for
 * them on the right, and every arrow drawn left to right (A → B: B waits for
 * A). Drag from the earlier item's + handle to the later one to add a
 * dependency; click a solid edge to remove it. Implicit edges (shared
 * footprint) are dashed and read-only.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ServerRef } from "@opencode/plugin/gui";
import { usePlugin } from "@opencode/plugin/gui";
import { EmptyState, ErrorBanner, LoadingRow, SHARED_CSS, StatusChip, type ChipTone } from "opencode-shared/gui";
import { PlansRpc, type WorkGraph, type WorkGraphEdge } from "./contract";
import { useT } from "./i18n";
import {
  GRAPH_GAP_X,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_PAD,
  isTerminalWorkStatus,
  layoutWorkGraph,
  wouldCreateCycle,
  type GraphPlacement,
} from "../work-graph";
import graphCss from "./graph.scss?inline";

const CSS = graphCss;

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
  /** The card action, shared with the list and the board. */
  onAction?: ((id: string) => void) | undefined;
  /** Whether the item has an active plan (play) or needs planning (brain). */
  hasPlan?: ((id: string) => boolean) | undefined;
  /** Whether the item's plan is executing right now. */
  isRunning?: ((id: string) => boolean) | undefined;
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
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [linkInvalid, setLinkInvalid] = createSignal(false);
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

  /** One label per layer: the reading/execution order. */
  const stages = createMemo(() => {
    const current = layout();
    if (!current) return [];
    const counts = new Map<number, number>();
    for (const placement of current.placements) {
      counts.set(placement.layer, (counts.get(placement.layer) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([layer, count]) => ({
        layer,
        count,
        x: GRAPH_PAD + layer * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
      }));
  });

  const nodeTitle = (id: string): string => graph()?.nodes.find((node) => node.id === id)?.title ?? id;

  const fail = (title: string, description?: string | undefined) => {
    ctx.toast.show({
      title,
      ...(description ? { description } : {}),
      variant: "error",
    });
  };

  /** The node under the pointer, for the drop target and the ghost feedback. */
  const targetAt = (clientX: number, clientY: number): string | undefined =>
    document
      .elementFromPoint(clientX, clientY)
      ?.closest("[data-item-id]")
      ?.getAttribute("data-item-id") ?? undefined;

  // Read order: the dependency (left) points at the item that waits for it
  // (right), so the arrowhead always lands on the destination's left border.
  const edgePath = (edge: WorkGraphEdge): string | undefined => {
    const dependency = placements().get(edge.blocksID);
    const dependent = placements().get(edge.itemID);
    if (!dependency || !dependent) return undefined;
    const x1 = dependency.x + GRAPH_NODE_WIDTH;
    const y1 = dependency.y + GRAPH_NODE_HEIGHT / 2;
    const x2 = dependent.x - 6;
    const y2 = dependent.y + GRAPH_NODE_HEIGHT / 2;
    const bend = Math.max(24, Math.min(80, (x2 - x1) / 2));
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };

  const moveLink = (event: PointerEvent) => {
    const current = linking();
    if (!current || !container) return;
    const rect = container.getBoundingClientRect();
    const x = (event.clientX - rect.left - tx()) / scale();
    const y = (event.clientY - rect.top - ty()) / scale();
    setLinking({ ...current, x, y });
    const target = targetAt(event.clientX, event.clientY);
    const edges = graph()?.edges ?? [];
    setLinkInvalid(
      target !== undefined && target !== current.from
        ? wouldCreateCycle(edges, target, current.from)
        : false,
    );
  };

  const endLink = (event: PointerEvent) => {
    window.removeEventListener("pointermove", moveLink);
    const current = linking();
    setLinking(null);
    setLinkInvalid(false);
    if (!current) return;
    const target = targetAt(event.clientX, event.clientY);
    if (!target || target === current.from) return;
    // Drag runs from the earlier item to the later one: the drop takes the
    // dependency on the earlier item.
    const edges = graph()?.edges ?? [];
    if (wouldCreateCycle(edges, target, current.from)) {
      fail(
        t("work.graph.addError"),
        t("work.graph.cycle", nodeTitle(current.from), nodeTitle(target)),
      );
      return;
    }
    void props.server.client
      .rpc(PlansRpc)
      .addWorkItemDep({ itemID: target, blocksID: current.from })
      .then((result) => {
        if (!result.ok) {
          fail(t("work.graph.addError"), result.error);
          return;
        }
        void props.server.client
          .rpc(PlansRpc)
          .getWorkGraph({ initiativeID: props.initiativeID! })
          .then((value) => setGraph(value as WorkGraph));
      })
      .catch((cause: unknown) => fail(t("work.graph.addError"), cause instanceof Error ? cause.message : String(cause)));
  };

  const startLink = (event: PointerEvent, nodeID: string) => {
    event.preventDefault();
    event.stopPropagation();
    const placement = placements().get(nodeID);
    if (!placement) return;
    setLinkInvalid(false);
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
          fail(t("work.graph.removeError"), result.error);
          return;
        }
        void props.server.client
          .rpc(PlansRpc)
          .getWorkGraph({ initiativeID: props.initiativeID! })
          .then((value) => setGraph(value as WorkGraph));
      })
      .catch((cause: unknown) =>
        fail(t("work.graph.removeError"), cause instanceof Error ? cause.message : String(cause)),
      );
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
    if ((event.target as Element | null)?.closest("[data-item-id]")) return;
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
              <Show when={layout()?.hasCycle}>
                <ErrorBanner message={t("work.graph.cycleBanner")} />
              </Show>
              <div class="work-graph">
                <div class="work-graph-header">
                  <span class="work-graph-hint">{t("work.graph.hint")}</span>
                  <div class="work-graph-controls">
                    <ctx.ui.IconButton icon="plus" label={t("work.graph.zoomIn")} onClick={() => setScale((v) => Math.min(1.8, v + 0.1))} />
                    <ctx.ui.IconButton icon="minus" label={t("work.graph.zoomOut")} onClick={() => setScale((v) => Math.max(0.35, v - 0.1))} />
                    <ctx.ui.Button size="small" variant="ghost" onClick={fit}>
                      {t("work.graph.fit")}
                    </ctx.ui.Button>
                  </div>
                </div>
                <div
                  ref={container}
                  class="work-graph-viewport"
                  classList={{ "is-panning": panning() }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={onPointerUp}
                  onWheel={onWheel}
                  role="region"
                  aria-label={t("work.graph.region")}
                >
                  <div
                    class="work-graph-canvas"
                    style={{
                      width: `${layout()?.width ?? 0}px`,
                      height: `${layout()?.height ?? 0}px`,
                      transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})`,
                    }}
                  >
                    <For each={stages()}>
                      {(stage) => (
                        <span class="work-graph-stage" style={{ left: `${stage.x}px` }}>
                          {t("work.graph.stage", stage.layer + 1)}
                          <Show when={stage.count > 1}>
                            <span class="work-graph-stage-note">{t("work.graph.parallel")}</span>
                          </Show>
                        </span>
                      )}
                    </For>
                    <svg class="work-graph-edges" width={layout()?.width ?? 0} height={layout()?.height ?? 0}>
                      <defs>
                        <marker
                          id="work-graph-arrow"
                          viewBox="0 0 10 10"
                          refX="9.5"
                          refY="5"
                          markerWidth="11"
                          markerHeight="11"
                          markerUnits="userSpaceOnUse"
                          orient="auto"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" class="work-graph-arrow" />
                        </marker>
                        <marker
                          id="work-graph-arrow-implicit"
                          viewBox="0 0 10 10"
                          refX="9.5"
                          refY="5"
                          markerWidth="11"
                          markerHeight="11"
                          markerUnits="userSpaceOnUse"
                          orient="auto"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" class="work-graph-arrow is-implicit" />
                        </marker>
                        <marker
                          id="work-graph-arrow-ghost"
                          viewBox="0 0 10 10"
                          refX="9.5"
                          refY="5"
                          markerWidth="11"
                          markerHeight="11"
                          markerUnits="userSpaceOnUse"
                          orient="auto"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" class="work-graph-arrow is-ghost" />
                        </marker>
                        <marker
                          id="work-graph-arrow-invalid"
                          viewBox="0 0 10 10"
                          refX="9.5"
                          refY="5"
                          markerWidth="11"
                          markerHeight="11"
                          markerUnits="userSpaceOnUse"
                          orient="auto"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" class="work-graph-arrow is-invalid" />
                        </marker>
                      </defs>
                      <For each={current().edges}>
                        {(edge) => {
                          const path = edgePath(edge);
                          return (
                            <Show when={path}>
                              {(value) => (
                                <>
                                  <path
                                    class={`work-graph-edge is-${edge.kind}`}
                                    classList={{
                                      "is-active":
                                        hovered() !== null &&
                                        (edge.itemID === hovered() || edge.blocksID === hovered()),
                                      "is-dim":
                                        hovered() !== null &&
                                        edge.itemID !== hovered() &&
                                        edge.blocksID !== hovered(),
                                    }}
                                    d={value()}
                                    marker-end={
                                      edge.kind === "implicit"
                                        ? "url(#work-graph-arrow-implicit)"
                                        : "url(#work-graph-arrow)"
                                    }
                                  >
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
                              {(placement) => {
                                const x1 = placement().x + GRAPH_NODE_WIDTH;
                                const y1 = placement().y + GRAPH_NODE_HEIGHT / 2;
                                const bend = Math.max(24, Math.min(80, Math.abs(current_().x - x1) / 2));
                                return (
                                  <path
                                    class="work-graph-ghost"
                                    classList={{ "is-invalid": linkInvalid() }}
                                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${current_().x - bend} ${current_().y}, ${current_().x} ${current_().y}`}
                                    marker-end={
                                      linkInvalid()
                                        ? "url(#work-graph-arrow-invalid)"
                                        : "url(#work-graph-arrow-ghost)"
                                    }
                                  />
                                );
                              }}
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
                              classList={{ "is-active": hovered() === node.id }}
                              data-item-id={node.id}
                              style={{ left: `${placement().x}px`, top: `${placement().y}px` }}
                              role="button"
                              tabIndex={0}
                              onPointerEnter={() => setHovered(node.id)}
                              onPointerLeave={() => setHovered(null)}
                              onClick={() => props.onOpen(node.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  props.onOpen(node.id);
                                }
                              }}
                            >
                              <span class="work-graph-node-meta">
                                <StatusChip tone={statusTone(node.status)} label={t(`work.status.${node.status}`)} />
                              </span>
                              <span class="work-graph-node-title">{node.title}</span>
                              <span class="work-graph-node-foot">
                                <Show when={!isTerminalWorkStatus(node.status)}>
                                  <Show when={props.onAction}>
                                    <Show
                                      when={props.isRunning?.(node.id)}
                                      fallback={
                                        <ctx.ui.IconButton
                                          class={props.hasPlan?.(node.id) ? "play-icon" : undefined}
                                          icon={props.hasPlan?.(node.id) ? "fill-triangle-down" : "brain"}
                                          label={t(props.hasPlan?.(node.id) ? "work.card.execute" : "work.card.plan")}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            props.onAction?.(node.id);
                                          }}
                                        />
                                      }
                                    >
                                      <StatusChip tone="info" label={t("run.item.running")} />
                                    </Show>
                                  </Show>
                                </Show>
                                <Show when={node.plan}>
                                  {(plan) => (
                                    <span class="work-card-progress work-graph-progress">
                                      <span class="work-progress">
                                        <span
                                          class="work-progress-done"
                                          style={{
                                            width: `${plan().total === 0 ? 0 : Math.round((plan().done / plan().total) * 100)}%`,
                                          }}
                                        />
                                      </span>
                                      <span class="work-progress-label">
                                        {plan().done}/{plan().total}
                                      </span>
                                    </span>
                                  )}
                                </Show>
                              </span>
                              <span
                                class="work-graph-handle"
                                classList={{ "is-active": hovered() === node.id }}
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
                    <span class="work-graph-legend-line" /> {t("work.graph.explicit")} · {t("work.graph.legendFlow")}
                    <span class="work-graph-legend-line is-implicit" /> {t("work.graph.implicit")}
                  </div>
                </div>
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </>
  );
}
