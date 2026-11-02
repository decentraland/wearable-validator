/** P2 Model — rule-book order: materials (M-02…M-07) then geometry (M-01, M-08…M-15). */
import { textureCount } from "./texture-count/index.js";
import { textureSize } from "./texture-size/index.js";
import { textureFormat } from "./texture-format/index.js";
import { textureMaps } from "./texture-maps/index.js";
import { materialCount } from "./material-count/index.js";
import { materialNames } from "./material-names/index.js";
import { triangleCount } from "./triangle-count/index.js";
import { boundingBox } from "./bounding-box/index.js";
import { skeleton } from "./skeleton/index.js";
import { boneWeights } from "./bone-weights/index.js";
import { handsGeometry } from "./hands-geometry/index.js";
import { hidesReplaces } from "./hides-replaces/index.js";
import { staticMesh } from "./static-mesh/index.js";
import { springBones } from "./spring-bones/index.js";
import { representationsMatch } from "./representations-match/index.js";

export const modelChecks = [
  textureCount,
  textureSize,
  textureFormat,
  textureMaps,
  materialCount,
  materialNames,
  triangleCount,
  boundingBox,
  skeleton,
  boneWeights,
  handsGeometry,
  hidesReplaces,
  staticMesh,
  springBones,
  representationsMatch
];
