import type { TextAnnotation, TextDraft } from "./types";

export const TEXT_FONT_FAMILY =
  '"Segoe UI Variable", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif';
export const TEXT_LINE_HEIGHT = 1.35;

// Rasterize only the text, never the entire screenshot. Long captures still
// compose in Rust, and preview/export use the very same system-font pixels.
export function createTextAnnotation(
  draft: TextDraft,
  imageWidth: number,
  imageHeight: number,
): TextAnnotation | null {
  if (!draft.text.trim()) return null;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建文字画布");

  const lines = draft.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const font = `${draft.fontSize}px ${TEXT_FONT_FAMILY}`;
  context.font = font;
  const lineHeight = draft.fontSize * TEXT_LINE_HEIGHT;
  // Clip at the screenshot edge, exactly as the final PNG does.
  const width = Math.max(1, Math.min(
    Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width))) + 4,
    Math.ceil(imageWidth - draft.x),
  ));
  const height = Math.max(1, Math.min(
    Math.ceil(lines.length * lineHeight) + 4,
    Math.ceil(imageHeight - draft.y),
  ));
  if (width > 8192 || height > 8192 || width * height > 16_000_000) {
    throw new Error("文字区域过大，请减少文字或字号");
  }

  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.fillStyle = draft.color;
  context.textBaseline = "middle";
  lines.forEach((line, index) => {
    context.fillText(line, 2, (index + 0.5) * lineHeight + 2);
  });
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("文字渲染失败，请减少文字或字号");
  }
  return { ...draft, type: "text", width, height, dataUrl };
}
