// ACU's bundled model catalog advertises a 272k-token context window for
// acu-auto and the gpt-5.6 family. Character counts are only an approximation,
// so the review payload keeps room for image tokens, schema, and output.
export const ACU_CONTEXT_WINDOW_TOKENS = 272_000;
export const MAX_REVIEW_TEXT_CHARS = 200_000;
export const MAX_LLM_PROMPT_LENGTH = 20_000;
export const MAX_REVIEW_PROMPT_CHARS = 120_000;
export const MAX_REVIEW_UPSTREAM_CHARS = 40_000;
export const MAX_REVIEW_TEXT_MATERIAL_CHARS = 40_000;
export const MAX_REVIEW_TEXT_MATERIALS = 32;
export const MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS = 20_000;

// ACU Router defaults to a 32 MB decompressed request body. Data URLs expand
// binary data, so keep protocol and JSON headroom below that hard boundary.
export const MAX_REVIEW_REQUEST_BYTES = 28_000_000;
export const MAX_IMAGE_DATA_URL_CHARS = 20_000_000;
export const MAX_SINGLE_IMAGE_BYTES = 8_000_000;
export const MAX_REVIEW_IMAGE_MATERIALS = 32;

export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((payload.replace(/\s/g, "").length * 3) / 4);
}

export function selectPreparedImageUrls(
  images: Array<{ dataUrl?: string }> = []
): string[] {
  const selected: string[] = [];
  let usedChars = 0;

  for (const image of images.slice(0, MAX_REVIEW_IMAGE_MATERIALS)) {
    const dataUrl = image.dataUrl;
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) continue;
    if (usedChars + dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) continue;
    selected.push(dataUrl);
    usedChars += dataUrl.length;
  }

  return selected;
}

export function preparedImageStats(
  images: Array<{ dataUrl?: string }> = []
) {
  const prepared = images
    .slice(0, MAX_REVIEW_IMAGE_MATERIALS)
    .map((image) => image.dataUrl)
    .filter(
      (dataUrl): dataUrl is string =>
        Boolean(dataUrl && /^data:image\//i.test(dataUrl))
    );
  const selected = selectPreparedImageUrls(images);

  return {
    preparedCount: prepared.length,
    sentCount: selected.length,
    omittedCount: prepared.length - selected.length,
    sentDataUrlChars: selected.reduce(
      (sum, dataUrl) => sum + dataUrl.length,
      0
    ),
    sentImageBytes: selected.reduce(
      (sum, dataUrl) => sum + dataUrlByteLength(dataUrl),
      0
    ),
    budgetChars: MAX_IMAGE_DATA_URL_CHARS
  };
}
