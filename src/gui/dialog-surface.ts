/**
 * The panel chrome every dialog draws for itself.
 *
 * The host mounts `ctx.dialogs.open` content in a bare fixed layer — no
 * background, border or padding — so a dialog that only lays out its fields is
 * transparent over whatever is behind it. This is the same surface as
 * `.plan-editor`, the modal the panel already renders on its own.
 */

export const DIALOG_SURFACE_CSS = `
.plans-dialog-surface {
  box-sizing: border-box;
  max-height: min(86vh, 760px);
  overflow-y: auto;
  padding: 14px;
  border: 1px solid var(--v2-border-border-strong);
  border-radius: 8px;
  background: var(--v2-background-bg-layer-02);
  color: var(--v2-text-text-base);
  box-shadow: var(--v2-elevation-floating);
  pointer-events: auto;
}
`;
