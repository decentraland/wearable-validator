/**
 * M-16 Skin deformation — a mesh bound to the wrong skeleton, with weights lost on one side, or with a part following
 * the wrong bone collapses, stretches or spikes once the avatar moves. Curators send these back; a still render hides them.
 */
import type { Document } from "@gltf-transform/core";
import { hasSkinnedMesh } from "../../../logic/gltf.js";
import { poseDeltas, readSkinnedGeometry, skinPositions, type SkinnedGeometry } from "../../../logic/skinning.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import type { Manifest } from "../../../manifest/index.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "skin-deformation", group: "model", rule: "M-16", docs: `${WEARABLES}#skin-weighting` };

type Config = Manifest["skinDeformation"];

export interface PoseStretch {
  pose: string;
  label: string;
  local: boolean;
  /** Edges that grow by at least the local limit (and minRatio times their length). */
  localEdges: number;
  /** Edges that grow by at least the gross limit, as a share of all edges. */
  grossShare: number;
  maxGrowth: number;
  /** The bones the two ends of the most stretched edge follow, and its mesh. */
  bones: [string, string];
  node: string;
}

export interface SkinMeasurement {
  vertices: number;
  /** Vertices the avatar's bones pull further than the tolerance from where the mesh's main bone puts them. */
  bind: { vertices: number; maxOffset: number; bone: string; node: string };
  /** null when the binding is distorted: nothing else can be measured on a mesh that is already out of shape. */
  symmetry: { symmetric: boolean; pairs: number; differing: number; share: number; bone: string; mirrorBone: string } | null;
  stretch: PoseStretch[] | null;
  /** Share of all weight on the head bone and the bones under it. */
  headShare: number | null;
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));
const percent = (share: number): string => `${round(share * 100, 1)}%`;

/** The rig names its sides Left and Right; a mirrored bone is the same name with the side swapped. */
function mirrorBone(name: string): string {
  if (name.includes("Left")) return name.replace("Left", "Right");
  if (name.includes("Right")) return name.replace("Right", "Left");
  return name;
}

/** Per vertex, how much weight each rig bone carries (helper and spring bones count as the rig bone above them). */
function carrierWeights(geometry: SkinnedGeometry): Map<string, number>[] {
  const out: Map<string, number>[] = [];
  for (let v = 0; v < geometry.vertexCount; v++) {
    const byBone = new Map<string, number>();
    for (let c = 0; c < 4; c++) {
      const weight = geometry.weights[v * 4 + c];
      if (weight <= 0) continue;
      const joint = geometry.joints[geometry.influences[v * 4 + c]];
      const bone = joint.carrier ?? joint.name;
      byBone.set(bone, (byBone.get(bone) ?? 0) + weight);
    }
    out.push(byBone);
  }
  return out;
}

function dominant(weights: Map<string, number>): string {
  let best = "no bone";
  let most = 0;
  for (const [bone, weight] of weights) {
    if (weight > most) {
      most = weight;
      best = bone;
    }
  }
  return best;
}

const nodeOf = (geometry: SkinnedGeometry, vertex: number): string => geometry.parts.find((part) => vertex >= part.start && vertex < part.end)?.node ?? "mesh";

function distance(points: Float32Array, a: number, b: number): number {
  return Math.hypot(points[a * 3] - points[b * 3], points[a * 3 + 1] - points[b * 3 + 1], points[a * 3 + 2] - points[b * 3 + 2]);
}

/**
 * Distortion of the binding: the joint carrying the most weight says where the mesh as a whole lands on the avatar
 * (a scaled or moved armature moves everything together, which is not distortion); every vertex is compared with
 * where that joint alone would put it.
 */
function measureBind(geometry: SkinnedGeometry, bind: Float32Array, tolerance: number): SkinMeasurement["bind"] {
  const totals = new Float64Array(geometry.joints.length);
  for (let i = 0; i < geometry.weights.length; i++) totals[geometry.influences[i]] += geometry.weights[i];
  let main = -1;
  for (let j = 0; j < totals.length; j++) if (geometry.joints[j].bindOffset && (main < 0 || totals[j] > totals[main])) main = j;
  const out = { vertices: 0, maxOffset: 0, bone: "", node: "" };
  if (main < 0) return out;
  const m = geometry.joints[main].bindOffset!;
  const { positions } = geometry;
  for (let v = 0; v < geometry.vertexCount; v++) {
    let weighted = false;
    for (let c = 0; c < 4; c++) if (geometry.weights[v * 4 + c] > 0) weighted = true;
    if (!weighted) continue;
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const offset = Math.hypot(
      bind[v * 3] - (m[0] * x + m[4] * y + m[8] * z + m[12]),
      bind[v * 3 + 1] - (m[1] * x + m[5] * y + m[9] * z + m[13]),
      bind[v * 3 + 2] - (m[2] * x + m[6] * y + m[10] * z + m[14])
    );
    if (offset > tolerance) out.vertices++;
    if (offset > out.maxOffset) {
      out.maxOffset = offset;
      out.bone = geometry.joints[geometry.influences[v * 4]].name;
      out.node = nodeOf(geometry, v);
    }
  }
  return out;
}

function measureSymmetry(bind: Float32Array, weights: Map<string, number>[], config: Config["symmetry"]): NonNullable<SkinMeasurement["symmetry"]> {
  const cell = config.mirrorToleranceMeters;
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  const count = weights.length;
  for (let v = 0; v < count; v++) {
    const k = key(Math.round(bind[v * 3] / cell), Math.round(bind[v * 3 + 1] / cell), Math.round(bind[v * 3 + 2] / cell));
    const list = grid.get(k);
    if (list) list.push(v);
    else grid.set(k, [v]);
  }
  let offCentre = 0;
  let pairs = 0;
  let differing = 0;
  const examples = new Map<string, number>();
  for (let v = 0; v < count; v++) {
    const x = bind[v * 3];
    const y = bind[v * 3 + 1];
    const z = bind[v * 3 + 2];
    if (Math.abs(x) < config.centreBandMeters) continue;
    offCentre++;
    let mirror = -1;
    let nearest = cell;
    const cx = Math.round(-x / cell);
    const cy = Math.round(y / cell);
    const cz = Math.round(z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const u of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        const d = Math.hypot(bind[u * 3] + x, bind[u * 3 + 1] - y, bind[u * 3 + 2] - z);
        if (d < nearest) {
          nearest = d;
          mirror = u;
        }
      }
    }
    if (mirror < 0) continue;
    pairs++;
    const mirrored = new Map([...weights[mirror]].map(([bone, weight]) => [mirrorBone(bone), weight]));
    let difference = 0;
    for (const bone of new Set([...weights[v].keys(), ...mirrored.keys()])) difference += Math.abs((weights[v].get(bone) ?? 0) - (mirrored.get(bone) ?? 0));
    if (difference < config.minWeightDifference) continue;
    differing++;
    // left vertex's bone | right vertex's bone, so both halves of a pair count as the same example
    const example = x > 0 ? `${dominant(weights[v])}|${mirrorBone(dominant(mirrored))}` : `${mirrorBone(dominant(mirrored))}|${dominant(weights[v])}`;
    examples.set(example, (examples.get(example) ?? 0) + 1);
  }
  const symmetric = offCentre >= config.minVertices && pairs >= config.minMirroredShare * offCentre;
  const [bone, other] = ([...examples].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "|").split("|");
  return { symmetric, pairs, differing, share: pairs > 0 ? differing / pairs : 0, bone, mirrorBone: other };
}

function uniqueEdges(geometry: SkinnedGeometry): [number, number][] {
  const seen = new Set<number>();
  const edges: [number, number][] = [];
  const { triangles, vertexCount } = geometry;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let side = 0; side < 3; side++) {
      const a = triangles[t + side];
      const b = triangles[t + ((side + 1) % 3)];
      if (a === b) continue;
      const id = a < b ? a * vertexCount + b : b * vertexCount + a;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(a < b ? [a, b] : [b, a]);
    }
  }
  return edges;
}

function measureStretch(geometry: SkinnedGeometry, bind: Float32Array, weights: Map<string, number>[], config: Config): PoseStretch[] {
  const edges = uniqueEdges(geometry);
  const lengths = edges.map(([a, b]) => distance(bind, a, b));
  const { minRatio, localGrowthMeters, grossGrowthMeters } = config.stretch;
  return config.poses.map((pose) => {
    const posed = skinPositions(geometry, poseDeltas(config.rig, pose));
    let localEdges = 0;
    let grossEdges = 0;
    let maxGrowth = 0;
    let worst = -1;
    edges.forEach(([a, b], index) => {
      const length = distance(posed, a, b);
      const growth = length - lengths[index];
      if (growth <= 0 || length < minRatio * lengths[index]) return;
      if (growth >= localGrowthMeters) localEdges++;
      if (growth >= grossGrowthMeters) grossEdges++;
      if (growth > maxGrowth) {
        maxGrowth = growth;
        worst = index;
      }
    });
    const [a, b] = worst >= 0 ? edges[worst] : [0, 0];
    return {
      pose: pose.name,
      label: pose.label,
      local: pose.local,
      localEdges,
      grossShare: edges.length > 0 ? grossEdges / edges.length : 0,
      maxGrowth,
      bones: worst >= 0 ? [dominant(weights[a]), dominant(weights[b])] : ["", ""],
      node: worst >= 0 ? nodeOf(geometry, a) : ""
    };
  });
}

/** Everything the rule measures on one model; null when it has no skinned mesh. Thresholds are applied by `run`. */
export function measureSkinDeformation(doc: Document, config: Config): SkinMeasurement | null {
  const geometry = readSkinnedGeometry(doc, config.rig);
  return geometry ? measureGeometry(geometry, config) : null;
}

export function measureGeometry(geometry: SkinnedGeometry, config: Config): SkinMeasurement {
  const bind = skinPositions(geometry);
  const bindMeasure = measureBind(geometry, bind, config.bindPoseToleranceMeters);
  if (bindMeasure.vertices > 0) return { vertices: geometry.vertexCount, bind: bindMeasure, symmetry: null, stretch: null, headShare: null };
  const weights = carrierWeights(geometry);
  const headBones = new Set<string>();
  for (const bone of config.rig) if (bone.name === config.headFollow.bone || (bone.parent !== null && headBones.has(bone.parent))) headBones.add(bone.name);
  let head = 0;
  let total = 0;
  for (const byBone of weights) for (const [bone, weight] of byBone) {
    total += weight;
    if (headBones.has(bone)) head += weight;
  }
  return {
    vertices: geometry.vertexCount,
    bind: bindMeasure,
    symmetry: measureSymmetry(bind, weights, config.symmetry),
    stretch: measureStretch(geometry, bind, weights, config),
    headShare: total > 0 ? head / total : null
  };
}

/** The findings one model's measurements amount to under the manifest's limits. */
export function skinDeformationFindings(file: string, measured: SkinMeasurement, config: Config, category: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const { bind, symmetry, stretch, headShare } = measured;
  if (bind.vertices > 0) {
    const tolerance = config.bindPoseToleranceMeters;
    findings.push(
      finding(meta, "error",
        `"${file}": ${bind.vertices} of ${measured.vertices} vertices are bound to bones that do not stand where the avatar's bones stand, so the avatar pulls the mesh out of shape: up to ${round(bind.maxOffset)} m, worst around "${bind.bone}" on mesh "${bind.node}" (allowed ${tolerance} m). It can look right in Blender and still collapse in-world. Rig the mesh on the official armature (Avatar_File.blend) without moving, scaling or re-orienting its bones, apply the armature's transforms, and export again.`,
        { where: file, measured: round(bind.maxOffset), limit: tolerance, data: { signal: "bind-pose", vertices: bind.vertices, bone: bind.bone, mesh: bind.node } })
    );
    return findings;
  }
  if (symmetry && symmetry.symmetric && symmetry.share >= config.symmetry.warnShare) {
    const severity = symmetry.share >= config.symmetry.errorShare ? "error" : "warning";
    const limit = severity === "error" ? config.symmetry.errorShare : config.symmetry.warnShare;
    findings.push(
      finding(meta, severity,
        `"${file}": the mesh is the same on both sides, but ${symmetry.differing} of ${symmetry.pairs} mirrored vertices (${percent(symmetry.share)}) are weighted differently from their mirror — the limit is ${percent(limit)}. Mostly, the left side follows "${symmetry.bone}" where the right side follows "${symmetry.mirrorBone}", so one side collapses or stretches when the avatar moves. Repaint that side, or copy the good side over (in Blender Weight Paint: Weights → Mirror, or a Mirror modifier with Vertex Groups on), and export again.`,
        { where: file, measured: round(symmetry.share), limit, data: { signal: "symmetry", vertices: symmetry.differing, bone: symmetry.bone, mirrorBone: symmetry.mirrorBone } })
    );
  }
  // the arms, head and torso never stretch an approved mesh this much; the legs come close on gowns, so there it only warns
  const byShare = (a: PoseStretch, b: PoseStretch): number => b.grossShare - a.grossShare;
  const grossPoses = stretch?.filter((pose) => pose.grossShare >= config.stretch.grossEdgeShare) ?? [];
  const gross = grossPoses.filter((pose) => pose.local).sort(byShare)[0] ?? grossPoses.sort(byShare)[0];
  if (gross) {
    findings.push(
      finding(meta, gross.local ? "error" : "warning",
        `"${file}": ${gross.label}, ${percent(gross.grossShare)} of the mesh's edges stretch by ${config.stretch.grossGrowthMeters} m or more (up to ${round(gross.maxGrowth)} m) — the limit is ${percent(config.stretch.grossEdgeShare)}. The worst is on mesh "${gross.node}", between vertices that follow "${gross.bones[0]}" and "${gross.bones[1]}": neighbouring vertices are weighted to bones that move apart. Check the vertex groups are assigned to the right bones and repaint so weights blend smoothly between them.`,
        { where: file, measured: round(gross.grossShare), limit: config.stretch.grossEdgeShare, data: { signal: "stretch", pose: gross.pose, growthMeters: round(gross.maxGrowth), mesh: gross.node, bones: gross.bones } })
    );
  }
  if (!gross || !gross.local) {
    const local = stretch?.filter((pose) => pose.local && pose.localEdges >= config.stretch.localMinEdges).sort((a, b) => b.maxGrowth - a.maxGrowth)[0];
    if (local) {
      findings.push(
        finding(meta, "warning",
          `"${file}": ${local.label}, ${local.localEdges} edges stretch by ${config.stretch.localGrowthMeters} m or more (up to ${round(local.maxGrowth)} m), which shows as a spike or a part pulled away from the body. The worst is on mesh "${local.node}", between vertices that follow "${local.bones[0]}" and "${local.bones[1]}". Weight that part to the bone of the piece it hangs from, or smooth the weights between the two bones, and check it in that pose.`,
          { where: file, measured: round(local.maxGrowth), limit: config.stretch.localGrowthMeters, data: { signal: "spike", pose: local.pose, edges: local.localEdges, mesh: local.node, bones: local.bones } })
      );
    }
  }
  const { bone, categories, minWeightShare } = config.headFollow;
  if (category !== undefined && categories.includes(category) && headShare !== null && headShare < minWeightShare) {
    findings.push(
      finding(meta, "warning",
        `"${file}": this item is worn on the head (${category}), but only ${percent(headShare)} of its weight is on the head bone "${bone}" — expected at least ${percent(minWeightShare)}. It will not follow the head when the head turns or nods. Weight the item to "${bone}".`,
        { where: file, measured: round(headShare), limit: minWeightShare, data: { signal: "head-follow", bone } })
    );
  }
  return findings;
}

export const skinDeformation: CheckDefinition = {
  ...meta,
  title: "Skin deformation",
  describe: "A skinned mesh keeps its shape on the avatar: bound to the avatar's bind pose, weighted the same on both sides, and without parts that stretch or stay behind in standard poses.",
  explanation: "The avatar moves your mesh with its own bones. If the mesh was bound to a different skeleton pose, lost its weights on one side, or has a part weighted to the wrong bone, it collapses, stretches or spikes as soon as the avatar moves, even when it looks right in Blender.",
  fix: "Rig on the official armature from the Blender toolkit (Avatar_File.blend) without moving, scaling or re-orienting its bones, and apply the armature's transforms before export. In Weight Paint, check both sides are painted (Weights → Mirror), that small hanging parts follow the bone of the piece they hang from, and that head items are weighted to Avatar_Head. Then pose the armature (arms down, arms up, head turned) and look for spikes.",
  details: "Reads joints, weights and inverse bind matrices from the file and skins the mesh with the avatar's own skeleton, as the avatar does. It measures four things: vertices the avatar's bind pose moves away from the rest of the mesh (more than 0.01 m fails); mirrored vertex pairs with different weights on a mesh that is the same on both sides (5% warns, 25% fails); edges that stretch by 0.15 m or more in standard poses (3 edges with the arms, head or torso moved warn; 2% of all edges fails there, and warns with the legs moved, where skirts stretch by design); and, for head items, the share of weight on the head bone (under 50% warns).",
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
    if (base !== true) return base;
    if (ctx.models.length > 0 && !ctx.models.some((m) => hasSkinnedMesh(m.doc))) return "no skinned mesh — rigid accessory";
    return true;
  },
  measure: (ctx) => {
    const config = ctx.manifest.skinDeformation;
    let offset = 0;
    let growth = 0;
    let any = false;
    for (const model of ctx.models) {
      const measured = measureSkinDeformation(model.doc, config);
      if (!measured) continue;
      any = true;
      offset = Math.max(offset, measured.bind.vertices > 0 ? measured.bind.maxOffset : 0);
      for (const pose of measured.stretch ?? []) if (pose.local) growth = Math.max(growth, pose.maxGrowth);
    }
    if (!any) return "not skinned";
    return offset > 0 ? `bind pose off by ${round(offset)} m` : `largest stretch ${round(growth)} m`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const config = ctx.manifest.skinDeformation;
    for (const model of ctx.models) {
      const measured = measureSkinDeformation(model.doc, config);
      if (measured) findings.push(...skinDeformationFindings(model.mainFile, measured, config, ctx.category));
    }
    return findings;
  }
};
