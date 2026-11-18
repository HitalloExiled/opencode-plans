/**
 * The panel chrome every dialog draws for itself.
 *
 * The host mounts `ctx.dialogs.open` content in a bare fixed layer — no
 * background, border or padding — so a dialog that only lays out its fields is
 * transparent over whatever is behind it. This is the same surface as
 * `.plan-editor`, the modal the panel already renders on its own.
 */

import dialogSurfaceCss from "./dialog-surface.scss?inline";

export const DIALOG_SURFACE_CSS = dialogSurfaceCss;
