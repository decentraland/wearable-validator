/**
 * M-17 Skin deformation — a mesh bound to the wrong skeleton, with its joints listed in another order than the avatar's,
 * with weights lost on one side, or with a part following the wrong bone collapses, stretches or spikes once the avatar
 * moves. Curators send these back; a still render hides them.
 *
 * It skins the mesh as the client does (unity-explorer, ComputeShaderSkinning.compute):
 * vertex = Σ weight × avatar bone[i] × the file's inverse bind matrix[i] × stored position, where i is the joint's
 * position in the file's joint list. Names play no part there, so a file that lists its joints in another order looks
 * right in Blender and in the Builder (both match by name) and breaks in-world.
 */
import type { Document } from "@gltf-transform/core";
import { listSome } from "../../../logic/format.js";
import { hasSkinnedMesh } from "../../../logic/gltf.js";
import { countSkinnedVertices, poseDeltas, readSkinnedGeometry, skinPositions, type SkinnedGeometry } from "../../../logic/skinning.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { manifest, type Manifest } from "../../../manifest/index.js";
import { finding, type CheckDefinition, type CheckExecution, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "skin-deformation", group: "model", rule: "M-17", docs: `${WEARABLES}#skin-weighting` };

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
  /** Among vertices on joints that are in place: those the avatar's bones pull further than the tolerance from where the mesh as a whole lands. */
  bind: { vertices: number; maxOffset: number; bone: string; node: string };
  /**
   * Rig bones the file lists at another position than the avatar has them (`joints`), the vertices weighted to them,
   * and the misplaced joint that carries the most weight.
   */
  order: { joints: number; vertices: number; maxOffset: number; slot: number; name: string; expected: string; node: string };
  /** Vertices with weight on a joint index the skin does not have. */
  invalidInfluences: number;
  /** Skinned meshes without joints or weights. */
  unweighted: string[];
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
 * Where the mesh lands on the avatar in the bind pose, and which vertices do not land with it.
 *
 * The avatar's bone i moves the file's joint i. A rig bone the file lists at another position is misplaced: another
 * bone moves the vertices painted for it. Joints with names the rig does not have are not an order problem;
 * skeleton (M-09) reports those.
 *
 * Joints in place and bound to the avatar's pose all carry the same bind offset: the identity, or one scale and shift
 * when the whole armature was scaled or moved, which moves everything together and is not distortion. Among the
 * joints in place, the offset that carries the most weight (then the one most joints share) says where the mesh as a
 * whole lands; every vertex is compared with where that offset alone would put it. Vertices on misplaced joints count
 * for the order, the others for the binding.
 */
function measurePlacement(geometry: SkinnedGeometry, bind: Float32Array, config: Config): Pick<SkinMeasurement, "bind" | "order"> {
  const { rig, bindPoseToleranceMeters: tolerance, offsetMatchMeters } = config;
  const rigNames = new Set(rig.map((bone) => bone.name));
  const misplaced = geometry.joints.map((joint) => joint.slot !== null && joint.name !== rig[joint.slot].name && rigNames.has(joint.name));
  const totals = new Float64Array(geometry.joints.length);
  for (let i = 0; i < geometry.weights.length; i++) totals[geometry.influences[i]] += geometry.weights[i];

  const groups = new Map<string, { weight: number; joints: number; joint: number }>();
  const group = (onlyInPlace: boolean): void => {
    geometry.joints.forEach((joint, index) => {
      if (!joint.bindOffset || joint.slot === null || (onlyInPlace && misplaced[index])) return;
      const key = joint.bindOffset.map((value) => Math.round(value / offsetMatchMeters)).join(",");
      const known = groups.get(key);
      if (known) {
        known.weight += totals[index];
        known.joints++;
      } else groups.set(key, { weight: totals[index], joints: 1, joint: index });
    });
  };
  group(true);
  // a list with every rig bone out of place has no joint in place to go by
  if (groups.size === 0) group(false);
  let main: { weight: number; joints: number; joint: number } | undefined;
  for (const candidate of groups.values()) {
    if (!main || candidate.weight > main.weight || (candidate.weight === main.weight && candidate.joints > main.joints)) main = candidate;
  }

  const bindOut = { vertices: 0, maxOffset: 0, bone: "", node: "" };
  const order = { joints: 0, vertices: 0, maxOffset: 0, slot: -1, name: "", expected: "", node: "" };
  const distinct = new Set<string>();
  let heaviest = -1;
  geometry.joints.forEach((joint, index) => {
    if (!misplaced[index]) return;
    // skins that repeat one joint list count each misplaced bone once
    distinct.add(`${joint.slot}:${joint.name}`);
    if (totals[index] > 0 && (heaviest < 0 || totals[index] > totals[heaviest])) heaviest = index;
  });
  order.joints = distinct.size;
  if (heaviest >= 0) {
    const joint = geometry.joints[heaviest];
    order.slot = joint.slot!;
    order.name = joint.name;
    order.expected = rig[joint.slot!].name;
  }
  if (!main) return { bind: bindOut, order };

  const m = geometry.joints[main.joint].bindOffset!;
  const { positions, influences, weights } = geometry;
  let worstBind = -1;
  let worstOrder = -1;
  for (let v = 0; v < geometry.vertexCount; v++) {
    // a vertex without weight is bone-weights' finding; one held by a joint nothing carries has no place on the avatar to compare
    if (!(weights[v * 4] > 0) || !geometry.joints[influences[v * 4]].bindOffset) continue;
    let onMisplaced = false;
    for (let c = 0; c < 4; c++) if (weights[v * 4 + c] > 0 && misplaced[influences[v * 4 + c]]) onMisplaced = true;
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const offset = Math.hypot(
      bind[v * 3] - (m[0] * x + m[4] * y + m[8] * z + m[12]),
      bind[v * 3 + 1] - (m[1] * x + m[5] * y + m[9] * z + m[13]),
      bind[v * 3 + 2] - (m[2] * x + m[6] * y + m[10] * z + m[14])
    );
    if (onMisplaced) {
      order.vertices++;
      if (offset >= order.maxOffset) {
        order.maxOffset = offset;
        worstOrder = v;
      }
    } else {
      if (offset > tolerance) bindOut.vertices++;
      if (offset > bindOut.maxOffset) {
        bindOut.maxOffset = offset;
        worstBind = v;
      }
    }
  }
  if (worstBind >= 0) {
    bindOut.bone = geometry.joints[influences[worstBind * 4]].name;
    bindOut.node = nodeOf(geometry, worstBind);
  }
  if (worstOrder >= 0) order.node = nodeOf(geometry, worstOrder);
  return { bind: bindOut, order };
}

function measureSymmetry(bind: Float32Array, weights: Map<string, number>[], config: Config["symmetry"]): NonNullable<SkinMeasurement["symmetry"]> {
  const cell = config.mirrorToleranceMeters;
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  const count = weights.length;
  for (let v = 0; v < count; v++) {
    const k = key(Math.round(bind[v * 3] / cell), Math.round(bind[v * 3 + 1] / cell), Math.round(bind[v * 3 + 2] / cell));
    const list = grid.get(k);
    // vertices stacked on one point are one candidate for a mirror: past the cap a cell takes no more, so the search stays linear
    if (!list) grid.set(k, [v]);
    else if (list.length < config.maxCellVertices) list.push(v);
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

/** A model with more skinned vertices than the rule measures. */
export interface SkinOversize {
  oversize: number;
}

const measured = new WeakMap<Document, { config: Config; measurement: SkinMeasurement | SkinOversize | null }>();

/**
 * Everything the rule measures on one model; null when it has no skinned mesh, and only the vertex count when it has
 * more than the rule measures. Thresholds are applied by skinDeformationFindings. Measured once per document: `run`
 * and `measure` share the result.
 */
export function measureSkinDeformation(doc: Document, config: Config): SkinMeasurement | SkinOversize | null {
  const known = measured.get(doc);
  if (known && known.config === config) return known.measurement;
  const count = countSkinnedVertices(doc);
  let measurement: SkinMeasurement | SkinOversize | null = null;
  if (count !== null && count > config.maxVertices) measurement = { oversize: count };
  else if (count !== null) measurement = measureGeometry(readSkinnedGeometry(doc, config.rig)!, config);
  measured.set(doc, { config, measurement });
  return measurement;
}

/** The measurement of a geometry already read. Exported with skinDeformationFindings for calibration runs, which break a clean geometry on purpose. */
export function measureGeometry(geometry: SkinnedGeometry, config: Config): SkinMeasurement {
  const bind = skinPositions(geometry);
  const base = { vertices: geometry.vertexCount, ...measurePlacement(geometry, bind, config), invalidInfluences: geometry.invalidInfluences, unweighted: geometry.unweighted };
  if (base.bind.vertices > 0 || base.order.vertices > 0 || geometry.vertexCount === 0) return { ...base, symmetry: null, stretch: null, headShare: null };
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
    ...base,
    symmetry: measureSymmetry(bind, weights, config.symmetry),
    stretch: measureStretch(geometry, bind, weights, config),
    headShare: total > 0 ? head / total : null
  };
}

/** The findings one model's measurements amount to under the manifest's limits. */
export function skinDeformationFindings(file: string, measured: SkinMeasurement, config: Config, category: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const { bind, order, symmetry, stretch, headShare } = measured;
  if (measured.unweighted.length > 0) {
    findings.push(
      finding(meta, "warning",
        `"${file}": ${listSome(measured.unweighted.map((name) => `"${name}"`))} ${measured.unweighted.length === 1 ? "is a skinned mesh" : "are skinned meshes"} without joints or weights, so no bone moves ${measured.unweighted.length === 1 ? "it" : "them"}. Parent the mesh to the armature with weights (in Blender: select the mesh, then the armature, Ctrl+P → With Empty Groups or Automatic Weights) and paint it, or delete it if it is a leftover.`,
        { where: file, measured: measured.unweighted.length, data: { signal: "unweighted", meshes: measured.unweighted } })
    );
  }
  if (measured.invalidInfluences > 0) {
    findings.push(
      finding(meta, "error",
        `"${file}": ${measured.invalidInfluences} of ${measured.vertices} vertices are weighted to a joint number the skin does not have. In-world they follow whatever bone sits at that number, or none. The export is damaged: export the model again from the original file (in Blender: File → Export → glTF 2.0).`,
        { where: file, measured: measured.invalidInfluences, limit: 0, data: { signal: "joint-index", vertices: measured.invalidInfluences } })
    );
  }
  const tolerance = config.bindPoseToleranceMeters;
  if (order.vertices > 0) {
    const share = order.vertices / measured.vertices;
    const { errorShare } = config.jointOrder;
    const severity = share >= errorShare ? "error" : "warning";
    findings.push(
      finding(meta, severity,
        `"${file}": the skin lists its joints in another order than the avatar's skeleton: ${order.joints} ${order.joints === 1 ? "joint is" : "joints are"} out of place. Most of the weight on them is on "${order.name}", which the file has at position ${order.slot}, where the avatar has "${order.expected}". In-world, bones are matched by position, not by name, so the ${order.vertices} of ${measured.vertices} vertices (${percent(share)}) weighted to those joints follow other bones and land up to ${round(order.maxOffset)} m out of place, worst on mesh "${order.node}" — ${severity === "error" ? `${percent(errorShare)} of the mesh or more fails` : `under ${percent(errorShare)} of the mesh, so this is a warning`}. It looks right in Blender and in the Builder preview, which match by name. Skin the mesh to the official armature (Avatar_File.blend) instead of a rebuilt or re-imported one, and export again.`,
        { where: file, measured: round(share), limit: errorShare, data: { signal: "joint-order", vertices: order.vertices, offsetMeters: round(order.maxOffset), joints: order.joints, position: order.slot, bone: order.name, expected: order.expected, mesh: order.node } })
    );
  }
  if (bind.vertices > 0) {
    findings.push(
      finding(meta, "error",
        `"${file}": ${bind.vertices} of ${measured.vertices} vertices are bound to bones that do not stand where the avatar's bones stand, so the avatar pulls the mesh out of shape: up to ${round(bind.maxOffset)} m, worst around "${bind.bone}" on mesh "${bind.node}" (allowed ${tolerance} m). It can look right in Blender and still collapse in-world. Rig the mesh on the official armature (Avatar_File.blend) without moving, scaling or re-orienting its bones, apply the armature's transforms, and export again.`,
        { where: file, measured: round(bind.maxOffset), limit: tolerance, data: { signal: "bind-pose", vertices: bind.vertices, bone: bind.bone, mesh: bind.node } })
    );
  }
  // nothing else can be measured on a mesh that is already out of shape
  if (order.vertices > 0 || bind.vertices > 0) return findings;
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

/** Written from the manifest, so the text cannot drift from the limits the check applies. */
const DETAILS = ((config: Config): string => {
  const { stretch, symmetry, jointOrder, headFollow } = config;
  return [
    "Reads joints, weights and inverse bind matrices from the file and skins the mesh as the client does: each vertex is moved by the avatar's bone at the position its joint has in the file's joint list (bones are matched by position, not by name), through the file's inverse bind matrix for that position.",
    `It measures five things. Vertices weighted to joints the file lists at another position than the avatar's skeleton: under ${percent(jointOrder.errorShare)} of the mesh's vertices warns, ${percent(jointOrder.errorShare)} or more fails.`,
    `Vertices on joints that are in place but bound to bones standing elsewhere, which the avatar's bind pose moves away from the rest of the mesh: more than ${config.bindPoseToleranceMeters} m fails.`,
    `Mirrored vertex pairs with different weights on a mesh that is the same on both sides: ${percent(symmetry.warnShare)} warns, ${percent(symmetry.errorShare)} fails.`,
    `Edges that stretch by ${stretch.localGrowthMeters} m or more in standard poses: ${stretch.localMinEdges} edges with the arms, head or torso moved warn; ${percent(stretch.grossEdgeShare)} of all edges fails there, and warns with the legs moved, where skirts stretch by design.`,
    `For head items, the share of weight on the head bone: under ${percent(headFollow.minWeightShare)} warns.`,
    `A model with more than ${config.maxVertices.toLocaleString("en-US")} skinned vertices is not measured.`
  ].join(" ");
})(manifest.skinDeformation);

export const skinDeformation: CheckDefinition = {
  ...meta,
  title: "Skin deformation",
  describe: "A skinned mesh keeps its shape on the avatar: joints in the avatar's order, bound to the avatar's bind pose, weighted the same on both sides, and without parts that stretch or stay behind in standard poses.",
  explanation: "The avatar moves your mesh with its own bones. If the file lists its joints in another order than the avatar's skeleton, was bound to a different skeleton pose, lost its weights on one side, or has a part weighted to the wrong bone, it collapses, stretches or spikes as soon as the avatar moves, even when it looks right in Blender.",
  fix: "Rig on the official armature from the Blender toolkit (Avatar_File.blend) without moving, scaling or re-orienting its bones, and apply the armature's transforms before export. In Weight Paint, check both sides are painted (Weights → Mirror), that small hanging parts follow the bone of the piece they hang from, and that head items are weighted to Avatar_Head. Then pose the armature (arms down, arms up, head turned) and look for spikes.",
  details: DETAILS,
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
      const measurement = measureSkinDeformation(model.doc, config);
      if (!measurement) continue;
      if ("oversize" in measurement) return `${measurement.oversize.toLocaleString("en-US")} skinned vertices, not measured`;
      if (measurement.vertices === 0) continue;
      any = true;
      if (measurement.bind.vertices > 0) offset = Math.max(offset, measurement.bind.maxOffset);
      if (measurement.order.vertices > 0) offset = Math.max(offset, measurement.order.maxOffset);
      for (const pose of measurement.stretch ?? []) if (pose.local) growth = Math.max(growth, pose.maxGrowth);
    }
    if (!any) return "not skinned";
    return offset > 0 ? `out of shape by ${round(offset)} m on the avatar` : `largest stretch ${round(growth)} m`;
  },
  run: (ctx): Finding[] | CheckExecution => {
    const findings: Finding[] = [];
    const config = ctx.manifest.skinDeformation;
    for (const model of ctx.models) {
      const measurement = measureSkinDeformation(model.doc, config);
      if (!measurement) continue;
      if ("oversize" in measurement) {
        const count = measurement.oversize.toLocaleString("en-US");
        const limit = config.maxVertices.toLocaleString("en-US");
        return {
          status: "skipped",
          coverage: "missing",
          findings: [],
          reason: `"${model.mainFile}" has ${count} skinned vertices — skin deformation is measured up to ${limit}. Reduce the mesh (the triangle limit for the category is far below this) and validate again.`
        };
      }
      findings.push(...skinDeformationFindings(model.mainFile, measurement, config, ctx.category));
    }
    return findings;
  }
};
