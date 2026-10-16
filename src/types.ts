export type CaptureKind = "normal" | "long";

export interface CapturePayload {
  captureId: number;
  dataUrl: string;
  width: number;
  height: number;
  captureKind: CaptureKind;
}

export interface OverlaySnapshot {
  sessionId: number;
  monitorId: number;
  name: string;
  width: number;
  height: number;
  scaleFactor: number;
  dataUrl: string;
}

export interface CaptureRegion {
  sessionId: number;
  monitorId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

interface StrokeStyle {
  color: string;
  strokeWidth: number;
}

export type Annotation =
  | ({
      type: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
    } & StrokeStyle)
  | ({
      type: "arrow";
      start: Point;
      end: Point;
    } & StrokeStyle)
  | ({
      type: "pen";
      points: Point[];
    } & StrokeStyle)
  | TextAnnotation
  | {
      type: "mosaic";
      x: number;
      y: number;
      width: number;
      height: number;
      blockSize: number;
    };

export interface TextDraft extends Point {
  text: string;
  color: string;
  fontSize: number;
}

export interface TextAnnotation extends TextDraft {
  type: "text";
  dataUrl: string;
  width: number;
  height: number;
}

export type EditorTool = "pan" | "rect" | "arrow" | "pen" | "mosaic" | "text";

export interface LongCaptureStatus {
  status: "capturing" | "limitReached";
  totalHeight: number;
  message: string;
}
