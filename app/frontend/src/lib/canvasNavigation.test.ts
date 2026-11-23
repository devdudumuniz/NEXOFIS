import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  clampCanvasZoom,
  computeCanvasWheelInteraction,
  computeZoomAroundAnchor,
  normalizeWheelDelta,
} from './canvasNavigation';

describe('canvasNavigation (Figma-style Scroll vertical, Shift+Scroll horizontal, Ctrl+Scroll zoom)', () => {
  it('pans vertically with plain scroll without changing zoom or pan.x', () => {
    const start = { zoom: 1.1, pan: { x: 25, y: 10 } };
    const next = computeCanvasWheelInteraction(
      start,
      { deltaX: 0, deltaY: 120, shiftKey: false, ctrlKey: false, svgUnitsPerCssPx: 1.5 },
      { x: 630, y: 290 }
    );

    assert.equal(next.action, 'vertical-pan');
    assert.equal(next.zoom, 1.1);
    assert.equal(next.pan.x, 25);
    assert.equal(next.pan.y, -170); // 10 - 120 * 1.5
  });

  it('pans horizontally with Shift + vertical scroll without changing zoom or pan.y', () => {
    const start = { zoom: 1.2, pan: { x: 40, y: -15 } };
    const next = computeCanvasWheelInteraction(
      start,
      { deltaX: 0, deltaY: 100, shiftKey: true, ctrlKey: false, svgUnitsPerCssPx: 1.5 },
      { x: 630, y: 290 }
    );

    assert.equal(next.action, 'horizontal-pan');
    assert.equal(next.zoom, 1.2);
    assert.equal(next.pan.y, -15);
    assert.equal(next.pan.x, -110); // 40 - 100 * 1.5
  });

  it('pans horizontally when browser translates Shift + Scroll into deltaX', () => {
    const start = { zoom: 1, pan: { x: 0, y: 10 } };
    const next = computeCanvasWheelInteraction(
      start,
      { deltaX: -80, deltaY: 0, shiftKey: true, ctrlKey: false, svgUnitsPerCssPx: 1 },
      { x: 500, y: 250 }
    );

    assert.equal(next.action, 'horizontal-pan');
    assert.equal(next.zoom, 1);
    assert.equal(next.pan.x, 80);
    assert.equal(next.pan.y, 10);
  });

  it('zooms in on Ctrl + scroll up (deltaY < 0) and zooms out on Ctrl + scroll down (deltaY > 0)', () => {
    const center = { x: 600, y: 300 };
    const start = { zoom: 1, pan: { x: 0, y: 0 } };

    const zoomedIn = computeCanvasWheelInteraction(
      start,
      { deltaX: 0, deltaY: -120, shiftKey: false, ctrlKey: true, anchorViewBoxPoint: center },
      center
    );
    assert.equal(zoomedIn.action, 'zoom');
    assert.ok(zoomedIn.zoom > 1, 'Expected Ctrl + scroll up to zoom in');

    const zoomedOut = computeCanvasWheelInteraction(
      zoomedIn,
      { deltaX: 0, deltaY: 120, shiftKey: false, ctrlKey: true, anchorViewBoxPoint: center },
      center
    );
    assert.equal(zoomedOut.action, 'zoom');
    assert.ok(Math.abs(zoomedOut.zoom - 1) < 0.002, 'Expected symmetric Ctrl + scroll down to return near 1.0');
  });

  it('supports Cmd/Meta + scroll for macOS zoom', () => {
    const center = { x: 600, y: 300 };
    const start = { zoom: 1, pan: { x: 0, y: 0 } };
    const zoomedIn = computeCanvasWheelInteraction(
      start,
      { deltaX: 0, deltaY: -120, shiftKey: false, metaKey: true, anchorViewBoxPoint: center },
      center
    );
    assert.equal(zoomedIn.action, 'zoom');
    assert.ok(zoomedIn.zoom > 1);
  });

  it('keeps the pointer world coordinate pinned under the cursor during zoom', () => {
    const anchor = { x: 420, y: 180 };
    const start = { zoom: 1, pan: { x: 20, y: -10 } };
    const worldBeforeX = (anchor.x - start.pan.x) / start.zoom;
    const worldBeforeY = (anchor.y - start.pan.y) / start.zoom;

    const after = computeZoomAroundAnchor(start, 1.5, anchor);
    const screenAfterX = worldBeforeX * after.zoom + after.pan.x;
    const screenAfterY = worldBeforeY * after.zoom + after.pan.y;

    assert.ok(Math.abs(screenAfterX - anchor.x) < 0.05);
    assert.ok(Math.abs(screenAfterY - anchor.y) < 0.05);
  });

  it('clamps zoom strictly within MIN_CANVAS_ZOOM and MAX_CANVAS_ZOOM and normalizes delta modes', () => {
    assert.equal(clampCanvasZoom(0.05), MIN_CANVAS_ZOOM);
    assert.equal(clampCanvasZoom(9.99), MAX_CANVAS_ZOOM);
    assert.equal(normalizeWheelDelta(3, 1), 48);
    assert.equal(normalizeWheelDelta(1, 2), 400);
  });
});
