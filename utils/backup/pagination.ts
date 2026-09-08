export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number | null;
}

export interface PaginationDiagnostic {
  pages: number;
  items: number;
  duplicateItems: number;
  repeatedCursors: number;
  reportedTotal: number | null;
  complete: boolean;
}

export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<PageResult<T>>,
  identity: (item: T) => string,
  maxPages = 100_000
): Promise<{ items: T[]; diagnostic: PaginationDiagnostic }> {
  const items: T[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let reportedTotal: number | null = null;
  let duplicateItems = 0;
  let repeatedCursors = 0;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchPage(cursor);
    pages++;
    reportedTotal = page.total ?? reportedTotal;
    for (const item of page.items) {
      const id = identity(item);
      if (ids.has(id)) {
        duplicateItems++;
        continue;
      }
      ids.add(id);
      items.push(item);
    }
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor)) {
      repeatedCursors++;
      break;
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const complete =
    pages < maxPages &&
    repeatedCursors === 0 &&
    (reportedTotal === null || reportedTotal === items.length);
  return {
    items,
    diagnostic: {
      pages,
      items: items.length,
      duplicateItems,
      repeatedCursors,
      reportedTotal,
      complete
    }
  };
}
