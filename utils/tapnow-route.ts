const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function companionRoute(value: string): { canvasId: string | null; workspace: boolean } {
  try {
    const url = new URL(value);
    if (url.origin !== "https://app.tapnow.ai") return { canvasId: null, workspace: false };
    const classic = /^\/canvas\/([^/]+)\/?$/.exec(url.pathname);
    if (classic) {
      return { canvasId: UUID.test(classic[1]) ? classic[1] : null, workspace: true };
    }
    const project = /^\/(?:p|collection)\/([^/]+)\/?$/.exec(url.pathname);
    if (project && UUID.test(project[1])) {
      const id = url.searchParams.get("t") === "c" ? project[1] : url.searchParams.get("c");
      return { canvasId: id && UUID.test(id) ? id : null, workspace: true };
    }
    return { canvasId: null, workspace: url.pathname === "/canvas" };
  } catch {
    return { canvasId: null, workspace: false };
  }
}
