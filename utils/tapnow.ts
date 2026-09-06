import type {
  ReviewConnectionInfo,
  ReviewNodeInfo,
  ReviewReferenceBinding
} from "./reviewer";

export interface TapNowApiNode {
  id?: unknown;
  canvas_id?: unknown;
  type?: unknown;
  position?: unknown;
  measured?: unknown;
  dimensions?: unknown;
  parent_id?: unknown;
  extent?: unknown;
  source_position?: unknown;
  target_position?: unknown;
  short_id?: unknown;
  session_id?: unknown;
  created_by?: unknown;
  created_by_role?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  data?: unknown;
}

export interface TapNowApiConnection {
  id?: unknown;
  source?: unknown;
  target?: unknown;
  source_handle?: unknown;
  target_handle?: unknown;
  label?: unknown;
}

export interface TapNowApiRelation {
  incoming: string[];
  outgoing: string[];
}

export interface TapNowCanvasSnapshot {
  nodes: TapNowApiNode[];
  connections: TapNowApiConnection[];
  relations?: Record<string, TapNowApiRelation>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  const result = stringValue(value).trim();
  return result || null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mediaUrlList(data: Record<string, unknown>): string[] {
  const result: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
    if (!result.includes(value)) result.push(value);
  };

  const options = data.options;
  if (Array.isArray(options)) {
    for (const option of options) add(option);
  }
  add(data.src);
  const metadata = record(data.__metadata);
  add(metadata.url);
  return result;
}

function safeParams(data: Record<string, unknown>): Record<string, unknown> | null {
  const params = data.params;
  return params && typeof params === "object" && !Array.isArray(params)
    ? { ...record(params) }
    : null;
}

export function apiNodeType(node: TapNowApiNode | null | undefined): string | null {
  if (!node) return null;
  const data = record(node.data);
  return nullableString(node.type || data.node_type || data.type)?.toLowerCase() || null;
}

export function apiNodeMediaUrls(node: TapNowApiNode | null | undefined): string[] {
  return node ? mediaUrlList(record(node.data)) : [];
}

export function toReviewNodeInfo(
  node: TapNowApiNode,
  sourceImageUrl: (value: string) => string = (value) => value
): ReviewNodeInfo | null {
  const id = nullableString(node.id);
  if (!id) return null;
  const data = record(node.data);
  const metadata = record(data.__metadata);
  const position = record(node.position);
  const measured = record(node.measured);
  const media = mediaUrlList(data).map((url) => ({
    url: sourceImageUrl(url),
    width: numberValue(metadata.width),
    height: numberValue(metadata.height)
  }));
  const taskInfo = record(data.taskInfo);

  return {
    id,
    canvasId: nullableString(node.canvas_id),
    nodeType: apiNodeType(node),
    dataType: nullableString(data.type)?.toLowerCase() || null,
    title: nullableString(data.title),
    shortId: nullableString(node.short_id),
    data: { ...data },
    prompt: stringValue(data.prompt).trim(),
    text: stringValue(data.text).trim(),
    params: safeParams(data),
    media,
    taskStatus: nullableString(taskInfo.status),
    position: {
      x: numberValue(position.x),
      y: numberValue(position.y)
    },
    measured: {
      width: numberValue(measured.width),
      height: numberValue(measured.height)
    },
    dimensions: {
      width: numberValue(record(node.dimensions).width),
      height: numberValue(record(node.dimensions).height)
    },
    parentId: nullableString(node.parent_id),
    extent: nullableString(node.extent),
    sourcePosition: nullableString(node.source_position),
    targetPosition: nullableString(node.target_position),
    sessionId: nullableString(node.session_id),
    createdBy: nullableString(node.created_by),
    createdByRole: nullableString(node.created_by_role),
    createdAt: nullableString(node.created_at),
    updatedAt: nullableString(node.updated_at)
  };
}

export function toReviewConnectionInfo(
  connection: TapNowApiConnection
): ReviewConnectionInfo | null {
  const id = nullableString(connection.id);
  const source = nullableString(connection.source);
  const target = nullableString(connection.target);
  if (!id || !source || !target) return null;
  return {
    id,
    source,
    target,
    sourceHandle: nullableString(connection.source_handle),
    targetHandle: nullableString(connection.target_handle),
    label: stringValue(connection.label).trim()
  };
}

export function extractImageReferences(prompt: string): number[] {
  const result: number[] = [];
  const pattern = /\{\{\s*image\s*(\d+)\s*\}\}/gi;
  for (const match of prompt.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0 && !result.includes(number)) {
      result.push(number);
    }
  }
  return result;
}

export function buildReferenceBindings(
  prompt: string,
  incomingNodes: ReviewNodeInfo[],
  imageMaterialIds: Array<string | null>
): ReviewReferenceBinding[] {
  return extractImageReferences(prompt).map((number) => {
    const source = incomingNodes[number - 1];
    const materialId = imageMaterialIds[number - 1] || null;
    return {
      reference: `Image ${number}`,
      materialId,
      sourceNodeId: source?.id || null,
      sourceTitle: source?.title || null,
      resolved: Boolean(source && materialId)
    };
  });
}

export function snapshotFromPayload(payload: unknown): TapNowCanvasSnapshot | null {
  const root = record(payload);
  const data = record(root.data);
  const canvas = record(data.canvas);
  const nodes = Array.isArray(canvas.nodes) ? (canvas.nodes as TapNowApiNode[]) : [];
  const connections = Array.isArray(canvas.connections)
    ? (canvas.connections as TapNowApiConnection[])
    : [];
  if (!nodes.length && !connections.length) return null;
  return { nodes, connections, relations: relationsFromPayload(payload) || undefined };
}

function relationPeerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((peer) => {
      if (typeof peer === "string") return peer.trim();
      const item = record(peer);
      return nullableString(item.node_id || item.nodeId || item.id);
    })
    .filter((id): id is string => Boolean(id));
}

export function relationsFromPayload(
  payload: unknown
): Record<string, TapNowApiRelation> | null {
  const root = record(payload);
  const data = record(root.data);
  const relations = data.relations;
  if (!relations || typeof relations !== "object" || Array.isArray(relations)) {
    return null;
  }

  const result: Record<string, TapNowApiRelation> = {};
  for (const [nodeId, value] of Object.entries(relations)) {
    const relation = record(value);
    result[nodeId] = {
      incoming: relationPeerIds(relation.incoming),
      outgoing: relationPeerIds(relation.outgoing)
    };
  }
  return Object.keys(result).length ? result : null;
}
