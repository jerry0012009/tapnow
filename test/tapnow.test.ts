import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReferenceBindings,
  relationsFromPayload,
  snapshotFromPayload,
  toReviewConnectionInfo,
  toReviewNodeInfo
} from "../utils/tapnow";

const imageNode = (id: string, url: string) => ({
  id,
  type: "image",
  short_id: id.slice(0, 4),
  data: {
    __metadata: { url, width: 640, height: 360 },
    options: [url],
    src: url,
    prompt: "",
    title: "图片生成",
    type: "generate",
    params: { model: "nano-banana-flash" }
  }
});

test("reads TapNow canvas nodes and connections without DOM rendering", () => {
  const source = imageNode(
    "image-source",
    "https://files.tapnow.top/api/conversation/storage/uploads/source"
  );
  const target = {
    id: "image-target",
    canvas_id: "canvas-1",
    type: "image",
    position: { x: 10, y: 20 },
    measured: { width: 448, height: 250 },
    dimensions: { width: 448, height: 250 },
    created_by: "user-1",
    created_by_role: "user",
    extent: "",
    data: {
      __metadata: {
        url: "https://files.tapnow.top/api/conversation/storage/uploads/output",
        width: 640,
        height: 360
      },
      options: [
        "https://files.tapnow.top/api/conversation/storage/uploads/output"
      ],
      src: "https://files.tapnow.top/api/conversation/storage/uploads/output",
      prompt: "参考{{Image 1}}修改{{Image 2}}",
      params: { model: "nano-banana-flash" },
      taskInfo: { status: "completed" },
      title: "图片生成",
      type: "generate"
    }
  };
  const connection = {
    id: "connection-1",
    source: source.id,
    target: target.id,
    source_handle: "right",
    target_handle: "left",
    label: ""
  };

  const snapshot = snapshotFromPayload({
    data: {
      canvas: {
        nodes: [source, target],
        connections: [connection]
      }
    }
  });

  assert.ok(snapshot);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.connections.length, 1);
  const node = toReviewNodeInfo(target);
  assert.ok(node);
  assert.equal(node?.prompt, "参考{{Image 1}}修改{{Image 2}}");
  assert.equal(node?.canvasId, "canvas-1");
  assert.equal(node?.data.params.model, "nano-banana-flash");
  assert.equal(node?.dimensions.width, 448);
  assert.equal(node?.createdBy, "user-1");
  assert.equal(node?.taskStatus, "completed");
  assert.equal(node?.media[0]?.width, 640);
  assert.equal(toReviewConnectionInfo(connection)?.sourceHandle, "right");
});

test("preserves TapNow relations order for offscreen reference mapping", () => {
  const payload = {
    data: {
      relations: {
        target: {
          incoming: [
            { node_id: "image-second", short_id: "n2" },
            { node_id: "image-first", short_id: "n1" }
          ],
          outgoing: []
        }
      }
    }
  };
  assert.deepEqual(relationsFromPayload(payload), {
    target: {
      incoming: ["image-second", "image-first"],
      outgoing: []
    }
  });

  const incoming = [
    toReviewNodeInfo(
      imageNode(
        "image-second",
        "https://files.tapnow.top/api/conversation/storage/uploads/second"
      )
    ),
    toReviewNodeInfo(
      imageNode(
        "image-first",
        "https://files.tapnow.top/api/conversation/storage/uploads/first"
      )
    )
  ].filter((node): node is NonNullable<typeof node> => Boolean(node));

  assert.deepEqual(
    buildReferenceBindings("参考{{Image 1}}和{{Image 2}}", incoming, [
      "image-1",
      "image-2"
    ]),
    [
      {
        reference: "Image 1",
        materialId: "image-1",
        sourceNodeId: "image-second",
        sourceTitle: "图片生成",
        resolved: true
      },
      {
        reference: "Image 2",
        materialId: "image-2",
        sourceNodeId: "image-first",
        sourceTitle: "图片生成",
        resolved: true
      }
    ]
  );
});
