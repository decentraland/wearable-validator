/** Indexed meshes for the similarity tests: enough vertices and irregular connectivity to fingerprint, built from a seed. */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * A wavy sheet about 0.4 m wide at chest height: a grid whose quads are split along a random diagonal, with some
 * quads left out, so vertex valences vary the way a modelled mesh's do.
 */
export function bumpySheet(seed = 1, size = 14): { positions: Float32Array; indices: Uint32Array } {
  const next = random(seed);
  const positions: number[] = [];
  for (let row = 0; row <= size; row++) {
    for (let col = 0; col <= size; col++) {
      positions.push(-0.2 + (col + (next() - 0.5) * 0.6) * (0.4 / size), 1.1 + (row + (next() - 0.5) * 0.6) * (0.3 / size), 0.1 + next() * 0.05);
    }
  }
  const indices: number[] = [];
  const at = (row: number, col: number) => row * (size + 1) + col;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const hole = next() < 0.06 && row > 0 && col > 0 && row < size - 1 && col < size - 1;
      const flip = next() < 0.5;
      if (hole) continue;
      const [a, b, c, d] = [at(row, col), at(row, col + 1), at(row + 1, col + 1), at(row + 1, col)];
      if (flip) indices.push(a, b, c, a, c, d);
      else indices.push(a, b, d, b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A plain UV sphere: the kind of primitive whose connectivity every other sphere shares. */
export function uvSphere(rings = 10, segments = 16, radius = 0.15): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const polar = (Math.PI * ring) / rings, around = (2 * Math.PI * segment) / segments;
      positions.push(radius * Math.sin(polar) * Math.cos(around), 1.7 + radius * Math.cos(polar), radius * Math.sin(polar) * Math.sin(around));
    }
  }
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * segments + segment, b = ring * segments + ((segment + 1) % segments), c = a + segments, d = b + segments;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Two meshes as one: the second's indices shifted past the first's vertices. */
export function merged(...meshes: { positions: Float32Array; indices: Uint32Array }[]): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(base + index);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** The same mesh somewhere else. */
export function shifted(mesh: { positions: Float32Array; indices: Uint32Array }, by: [number, number, number]): { positions: Float32Array; indices: Uint32Array } {
  return { positions: mesh.positions.map((value, i) => value + by[i % 3]), indices: mesh.indices };
}
