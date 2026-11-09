import assert from "node:assert/strict";
import { test } from "node:test";
import { invert } from "./gltf.js";

test("invert handles rotation and scale, and returns null for a singular matrix", () => {
  // 90° about X, scale 2, then (1, 2, 3): column-major
  const m = [2, 0, 0, 0, 0, 0, 2, 0, 0, -2, 0, 0, 1, 2, 3, 1];
  const inverse = invert(m)!;
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += m[k * 4 + row] * inverse[col * 4 + k];
      assert.ok(Math.abs(sum - (row === col ? 1 : 0)) < 1e-9, `m × m⁻¹ at row ${row}, column ${col} is ${sum}`);
    }
  }
  assert.equal(invert(new Array(16).fill(0)), null);
});
