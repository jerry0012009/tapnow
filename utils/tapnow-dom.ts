export const CANVAS_NODE_SELECTOR = ".react-flow__node[data-id]";
export const PROMPT_SELECTOR = "[data-testid='canvas-node-prompt-textarea'], [data-testid='canvas-node-generation-input-bar'], [data-generation-input-shell], [data-photo-editor-prompt]";

export function canvasRoot(document: Document, canvasId: string | null): Element | Document {
  // V2 keeps inactive canvases mounted, including their selected nodes and editors.
  const instances = [...document.querySelectorAll("[data-canvas-instance]")];
  return instances.find((element) =>
    element.getAttribute("data-canvas-instance") === canvasId &&
    element.getAttribute("data-canvas-active") !== "false"
  ) || (instances.length ? document.createElement("div") : document);
}

export function canvasNodeFor(target: Element | null, root: Element | Document): Element | null {
  if (!target || !root.contains(target)) return null;
  // Mentions and connection handles also carry data-id. They are not canvas nodes.
  return target.closest(CANVAS_NODE_SELECTOR) ||
    target.closest("[data-node-id]:not(button):not([data-testid^='canvas-launchpad']), [data-node]:not(.classic-canvas-guide-launch-node)");
}

export function canvasNodeId(element: Element | null): string | null {
  if (!element) return null;
  const node = element.closest(CANVAS_NODE_SELECTOR) || element;
  for (const name of ["data-node-id", "data-id", "data-node"]) {
    const value = node.getAttribute(name);
    if (value && value.length < 200) return value;
  }
  return null;
}

export function selectedCanvasNode(root: Element | Document, rememberedId: string | null): Element | null {
  const selected = [...root.querySelectorAll(`${CANVAS_NODE_SELECTOR}.selected`)];
  return selected.find((element) => canvasNodeId(element) === rememberedId) ||
    (selected.length === 1 ? selected[0] : null);
}
