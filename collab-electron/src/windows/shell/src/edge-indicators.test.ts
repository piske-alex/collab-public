/**
 * Tests for pure logic in edge-indicators.js.
 */
import { describe, test, expect } from "bun:test";
import { isFullyOffScreen, rayRectIntersect } from "./edge-indicators.js";

// -- isFullyOffScreen --

describe("isFullyOffScreen", () => {
  const vw = 1000;
  const vh = 800;

  test("tile fully visible is not off screen", () => {
    const tile = { x: 100, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(false);
  });

  test("tile partially visible is not off screen", () => {
    // tile extends past right edge
    const tile = { x: 900, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(false);
  });

  test("tile fully off right edge", () => {
    const tile = { x: 1100, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);
  });

  test("tile fully off left edge", () => {
    const tile = { x: -300, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);
  });

  test("tile fully off top edge", () => {
    const tile = { x: 100, y: -300, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);
  });

  test("tile fully off bottom edge", () => {
    const tile = { x: 100, y: 900, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);
  });

  test("pan offset brings tile into view", () => {
    // tile at x=1100: left = 1100 + panX
    // Off screen when left >= vw(1000), i.e. panX >= -100
    const tile = { x: 1100, y: 100, width: 200, height: 200 };
    // panX=0: left=1100 >= 1000, off screen
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);
    // panX=-100: left=1000 >= 1000, still off screen (boundary)
    expect(isFullyOffScreen(tile, vw, vh, -100, 0, 1)).toBe(true);
    // panX=-101: left=999 < 1000, now visible
    expect(isFullyOffScreen(tile, vw, vh, -101, 0, 1)).toBe(false);
    // panX=-200: left=900, clearly visible
    expect(isFullyOffScreen(tile, vw, vh, -200, 0, 1)).toBe(false);
  });

  test("zoom affects off-screen calculation", () => {
    // tile at x=600, zoom=0.5: screen left = 600*0.5 = 300
    const tile = { x: 600, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 0.5)).toBe(false);

    // tile at x=2100, zoom=0.5: screen left = 2100*0.5 = 1050 >= vw
    const farTile = { x: 2100, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(farTile, vw, vh, 0, 0, 0.5)).toBe(true);
  });

  test("tile exactly touching edge is off screen", () => {
    // right edge exactly at 0
    const tile = { x: -200, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(true);

    // left edge exactly at vw
    const tile2 = { x: 1000, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile2, vw, vh, 0, 0, 1)).toBe(true);
  });

  test("1px overlap means not off screen", () => {
    // right edge at 1 (just barely visible)
    const tile = { x: -199, y: 100, width: 200, height: 200 };
    expect(isFullyOffScreen(tile, vw, vh, 0, 0, 1)).toBe(false);
  });
});

// -- rayRectIntersect --

describe("rayRectIntersect", () => {
  const vw = 1000;
  const vh = 800;
  const cx = 500; // viewport center
  const cy = 400;

  test("target to the right hits right edge", () => {
    const result = rayRectIntersect(cx, cy, 2000, 400, vw, vh);
    expect(result.x).toBe(vw - 8); // INSET = 8
    expect(result.y).toBe(400);
  });

  test("target to the left hits left edge", () => {
    const result = rayRectIntersect(cx, cy, -1000, 400, vw, vh);
    expect(result.x).toBe(8); // INSET
    expect(result.y).toBe(400);
  });

  test("target above hits top edge", () => {
    const result = rayRectIntersect(cx, cy, 500, -1000, vw, vh);
    expect(result.x).toBe(500);
    expect(result.y).toBe(8); // INSET
  });

  test("target below hits bottom edge", () => {
    const result = rayRectIntersect(cx, cy, 500, 2000, vw, vh);
    expect(result.x).toBe(500);
    expect(result.y).toBe(vh - 8); // INSET
  });

  test("diagonal target hits the closer edge", () => {
    // Target far to the right and slightly above — should hit right edge
    const result = rayRectIntersect(cx, cy, 3000, 300, vw, vh);
    expect(result.x).toBe(vw - 8);
    // y should be proportionally adjusted
    expect(result.y).toBeGreaterThan(350);
    expect(result.y).toBeLessThan(400);
  });

  test("returns center when target equals center (no movement)", () => {
    const result = rayRectIntersect(cx, cy, cx, cy, vw, vh);
    expect(result.x).toBe(cx);
    expect(result.y).toBe(cy);
  });

  test("corner target hits one of the two adjacent edges", () => {
    // Target far to upper-left
    const result = rayRectIntersect(cx, cy, -1000, -1000, vw, vh);
    // Should hit either left or top edge
    const hitsLeft = result.x === 8;
    const hitsTop = result.y === 8;
    expect(hitsLeft || hitsTop).toBe(true);
  });
});
