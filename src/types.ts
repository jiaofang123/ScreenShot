export type CaptureKind = "normal" | "long";

export interface CapturePayload {
  dataUrl: string;
  width: number;
  height: number;
  captureKind: CaptureKind;
}

export interface OverlaySnapshot {
  monitorId: number;
  name: string;
  width: number;
  height: number;
  scaleFactor: number;
  dataUrl: string;
}

export interface CaptureRegion {
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
  | {
      type: "mosaic";
      x: number;
      y: number;
      width: number;
      height: number;
      blockSize: number;
    };

export type EditorTool = "pan" | "rect" | "arrow" | "pen" | "mosaic";

export interface LongCaptureStatus {
  status: "capturing" | "limitReached";
  totalHeight: number;
  message: string;
}
