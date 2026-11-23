export const MIN_CANVAS_ZOOM = 0.4;
export const MAX_CANVAS_ZOOM = 2.5;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasTransform {
  zoom: number;
  pan: CanvasPoint;
}

export interface CanvasWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Pointer position in SVG viewBox coordinates (optional; defaults to canvas center). */
  anchorViewBoxPoint?: CanvasPoint;
  /** Conversion ratio from CSS pixels to SVG viewBox units (defaults to 1). */
  svgUnitsPerCssPx?: number;
}

export interface CanvasWheelResult extends CanvasTransform {
  action: 'vertical-pan' | 'horizontal-pan' | 'zoom' | 'none';
}

export function clampCanvasZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, Number(zoom.toFixed(4))));
}

/**
 * Normalizes WheelEvent delta across pixel (0), line (1), and page (2) modes.
 */
export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 400;
  return delta;
}

/**
 * Computes the next SVG `translate(pan.x, pan.y) scale(zoom)` transform
 * keeping `anchor` fixed in viewBox space while zooming (Figma-style cursor zoom).
 */
export function computeZoomAroundAnchor(
  current: CanvasTransform,
  nextZoomRaw: number,
  anchor: CanvasPoint
): CanvasTransform {
  const nextZoom = clampCanvasZoom(nextZoomRaw);
  if (nextZoom === current.zoom) {
    return current;
  }

  const worldX = (anchor.x - current.pan.x) / current.zoom;
  const worldY = (anchor.y - current.pan.y) / current.zoom;

  return {
    zoom: nextZoom,
    pan: {
      x: Number((anchor.x - worldX * nextZoom).toFixed(2)),
      y: Number((anchor.y - worldY * nextZoom).toFixed(2)),
    },
  };
}

/**
 * Figma-style wheel interaction for the graph canvas:
 * - Ctrl/Cmd + Scroll -> smooth cursor-anchored zoom
 * - Shift + Scroll    -> horizontal pan (`pan.x` shifts, `pan.y` and `zoom` stay fixed)
 * - Scroll only       -> vertical pan (`pan.y` shifts, `zoom` stays fixed; preserves trackpad `deltaX`)
 */
export function computeCanvasWheelInteraction(
  current: CanvasTransform,
  input: CanvasWheelInput,
  fallbackCenter: CanvasPoint
): CanvasWheelResult {
  const dx = normalizeWheelDelta(input.deltaX, input.deltaMode);
  const dy = normalizeWheelDelta(input.deltaY, input.deltaMode);
  const unitsPerPx =
    input.svgUnitsPerCssPx && Number.isFinite(input.svgUnitsPerCssPx) && input.svgUnitsPerCssPx > 0
      ? input.svgUnitsPerCssPx
      : 1;

  if (input.ctrlKey || input.metaKey) {
    const zoomDelta = dy !== 0 ? dy : dx;
    if (zoomDelta === 0) {
      return { ...current, action: 'none' };
    }
    const clampedZoomDelta = Math.max(-240, Math.min(240, zoomDelta));
    const zoomFactor = Math.exp(-clampedZoomDelta * 0.0015);
    const anchor = input.anchorViewBoxPoint ?? fallbackCenter;
    const next = computeZoomAroundAnchor(current, current.zoom * zoomFactor, anchor);
    return {
      ...next,
      action: 'zoom',
    };
  }

  if (input.shiftKey) {
    // Browsers may route Shift+Wheel into deltaX (macOS/Chromium) or keep it in deltaY (Linux/Windows/Firefox)
    const primaryDelta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (primaryDelta === 0) {
      return { ...current, action: 'none' };
    }
    const clampedDelta = Math.max(-480, Math.min(480, primaryDelta));
    return {
      action: 'horizontal-pan',
      zoom: current.zoom,
      pan: {
        x: Number((current.pan.x - clampedDelta * unitsPerPx).toFixed(2)),
        y: current.pan.y,
      },
    };
  }

  if (dx === 0 && dy === 0) {
    return { ...current, action: 'none' };
  }

  const clampedDx = Math.max(-480, Math.min(480, dx));
  const clampedDy = Math.max(-480, Math.min(480, dy));
  return {
    action: 'vertical-pan',
    zoom: current.zoom,
    pan: {
      x: Number((current.pan.x - clampedDx * unitsPerPx).toFixed(2)),
      y: Number((current.pan.y - clampedDy * unitsPerPx).toFixed(2)),
    },
  };
}
