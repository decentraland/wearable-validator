import manifestJson from "./manifest.json" with { type: "json" };

/** One bone of the avatar's skeleton. The rig lists them in the order the avatar indexes them (AvatarBase.prefab). */
export interface RigBone {
  name: string;
  /** null for the root bone. */
  parent: string | null;
  /** Column-major world matrix of the bone in the avatar's bind pose (a T-pose, metres, +Y up, facing +Z). */
  bindMatrix: number[];
}

export interface PoseRotation {
  bone: string;
  /** Avatar-space axis the bone turns around, at its own joint. */
  axis: "x" | "y" | "z";
  degrees: number;
}

export interface SkinPose {
  name: string;
  /** Creator-facing words for the pose: "with the arms down". */
  label: string;
  /** Applied in order; a bone listed twice turns twice. */
  rotations: PoseRotation[];
}

export interface Manifest {
  version: string;
  triangles: {
    default: number; perCategory: Record<string, number>; hiddenHandsBudget: number; headSlots: string[]; hiddenHeadLimit: number;
    /** Up to this share over the effective budget is a warning, not a rejection (curators' unanimous decision, Nov 2026). */
    warningMarginRatio: number;
  };
  textures: {
    default: number; skin: number; maxSize: number;
    /** Eyes, eyebrows and mouth PNGs: 1024×1024, the same as any other texture, since the curators' decision (Nov 2026). It was 256×256, then 512×512. */
    facialMaxSize: number;
  };
  /**
   * avatarSkinMat is the name creators should use. skinNameToken is what the engine looks for: any material whose name
   * contains it (any case) is tinted as skin, so those are the ones left out of the material and texture counts.
   * extraWithEmissionOrAlpha: materials allowed on top of `default` when the model uses emission or transparency, which
   * need a material of their own (curators' decision, Nov 2026). It does not apply to skins, which already get `skin`.
   */
  materials: { default: number; extraWithEmissionOrAlpha: number; skin: number; avatarSkinMat: string; skinNameToken: string; forbiddenMeshNamePatterns: string[] };
  facialCategories: string[];
  fileSize: {
    wearableBytes: number; skinBytes: number; emoteBytes: number;
    /** A wearable's model alone would have to stay this far under the item ceiling. 0 since the curators' decision (Nov 2026): no per-model rule, only the total counts. It was 1 MB. */
    modelHeadroomBytes: number;
    /** The same for emotes: 0 too, so every item is held only to its total, thumbnail included. */
    emoteModelHeadroomBytes: number;
    thumbnailBytes: number; thumbnailMaxSize: number;
    smartWearableVideoBytes: number; audioBytes: number; maxInputBytes: number;
    /** Zip bounds, checked against the declared sizes before inflating and against the real bytes while inflating. */
    maxEntries: number; maxUncompressedBytes: number; maxEntryUncompressedBytes: number;
  };
  /** Header width × height above which no check decodes an image to pixels (a decoded image costs at least 4 bytes per pixel). */
  images: {
    maxDecodePixels: number; inflateChunkBytes: number;
    /** Pixels the QR scan decodes across all of an item's textures: many texture entries can point at the same bytes. */
    maxScanPixels: number;
    /** A QR detection without content counts as a code only when its finder patterns' two sides differ by at most this ratio… */
    qrMaxSideRatio: number;
    /** …and its outline stays within this share of the image's longer side beyond the image's edges. */
    qrEdgeMarginRatio: number;
  };
  boundingBox: { width: number; height: number; depth: number };
  text: { nameMax: number; descriptionMax: number; forbiddenChars: string[]; tagsMax: number };
  skeleton: {
    armatureName: string; propArmatureName: string; maxInfluences: number; weightSumEpsilon: number;
    springBoneToken: string; maxSpringBones: number;
    springBone: { stiffness: [number, number]; gravityPower: [number, number]; drag: [number, number]; gravityDir: [number, number] };
  };
  emote: {
    maxDurationSeconds: number; expectedFps: number; fpsTolerance: number; maxFrames: number;
    maxClipsBasic: number; maxClipsWithProps: number;
    propMaxTriangles: number; propMaxMaterials: number; propMaxTextures: number; propMaxBones: number;
    propClipLengthToleranceSeconds: number; audioDurationToleranceSeconds: number;
    /**
     * The hips' distance from the centre of the animation area: over horizontalWarnMeters (the documented 1 m) warns, over
     * horizontalErrorMeters fails. Vertical travel from the first key: over verticalWarnMeters warns, over verticalErrorMeters fails.
     */
    rootMotion: { horizontalWarnMeters: number; horizontalErrorMeters: number; verticalWarnMeters: number; verticalErrorMeters: number; hipsPattern: string };
    maxSocialOutcomes: number;
  };
  epsilons: { loopSeamTranslation: number; loopSeamQuaternionDot: number; loopSeamScale: number; zUpRotationToleranceDegrees: number };
  gltf: {
    extensionAllowlist: string[]; unknownCodeSeverity: string; severityOverrides: Record<string, string>;
    /** Accessors (count × element size) plus embedded images (their buffer view): what parsing a model allocates, checked before it does. */
    maxUnpackedBytes: number;
  };
  hands: { minHandWeightRatio: number };
  thumbnail: { minTransparentBorderRatio: number; alphaThreshold: number };
  /** The renderer, shared by every visual rule — read by /native and captures.ts. */
  rendering: {
    imageSizePx: number;
    /** Bumped when the capture recipe (views, poses, scene) changes; part of every capture key. */
    recipeVersion: number;
    bodyShapes: string[];
    /** The capture recipe every visual rule draws from: views × azimuths per body shape, clip fractions for emotes. */
    views: { wearable: ("avatar" | "wearable")[]; emote: ("avatar" | "wearable")[] };
    azimuthDegrees: { wearable: number[]; emote: number[] };
    emoteFractions: number[];
    maxCaptures: number;
    /**
     * V-02's motion pass for wearables: worn views at clip moments that pull the garment, chosen per category,
     * with the skin in chroma green so skin through cloth is unmistakable. A category not listed uses "body".
     */
    stress: {
      skin: string;
      azimuthDegrees: number[];
      poses: Record<string, { clip: string; fraction: number }[]>;
      categoryPoses: Record<string, string>;
    };
    background: string; skin: string;
    wearablePose: string; wearablePoseFraction: number;
    /** One render server job's deadline. */
    loadTimeoutMs: number;
    maxCaptureBytes: number;
  };
  /** The one vision call, shared by every AI-backed rule — read by /ai (maxTextLength also by answer parsers). */
  ai: {
    model: string; maxInputTokens: number; maxImages: number; timeoutMs: number; maxRetries: number;
    thinkingBudgetTokens: number; imagePixelsPerToken: number; textCharactersPerToken: number; maxTextLength: number;
  };
  /**
   * M-15: the male and female versions of a body garment, each measured against its own skeleton (feet 0, head 1).
   * Approved items with separate versions differ by at most 0.1 at their top or bottom edge (p99 of 378 sampled).
   */
  representations: {
    /** A larger gap at the top or bottom edge means one version is at the wrong scale or position. */
    maxEdgeGap: number;
    /**
     * Categories whose separate versions are compared against maxEdgeGap. Only upper_body and lower_body were
     * calibrated (none of 300 approved items warned). Other categories legitimately differ by body: short male hair
     * with shoulder-length female hair is a 0.26 gap at the bottom edge, and hats, masks and helmets can differ too.
     */
    comparedCategories: string[];
    /** A garment whose bottom edge sits below this height reaches past the hips: one model for both bodies rarely fits. */
    hipLine: number;
    /**
     * Categories where one model worn by both bodies past the hips warns (feet, hands and skins are shared by design).
     * Empty for now: with upper_body and lower_body it warned on 37 of 300 approved items (12%), mostly long dresses,
     * coats and costumes curators accepted. Listing categories here turns it on; nothing else changes.
     */
    fittedCategories: string[];
  };
  /**
   * M-17: how a skinned mesh deforms on the avatar, measured from the file alone. Calibrated on 516 curator-approved
   * models (Nov 2026); each number names how many of them it flags.
   */
  skinDeformation: {
    /**
     * The avatar's skeleton in its bind pose (a T-pose), in the order the client indexes its bones (unity-explorer,
     * AvatarBase.prefab, the SkinnedMeshRenderer's bones). The client moves joint i of a file with bone i of this
     * list, whatever the joint is called, through the file's own inverse bind matrix. 670 of 678 skins in the
     * calibration set list their first 62 joints in exactly this order, and every approved model is bound to these
     * matrices to four decimals. Reordering this list changes the rule.
     */
    rig: RigBone[];
    /**
     * Skinned vertices the rule measures, each drawn piece counted once. Above it the check is skipped with a reason
     * instead of measured: the work grows with the vertex count, and the largest skin of the calibration set has
     * 9,942. A model this large is far over every triangle limit and fails triangle-count on its own.
     */
    maxVertices: number;
    /**
     * How far a vertex on joints that are in place may sit from where the mesh as a whole lands before the binding
     * counts as distorted. No approved model moves such a vertex by 0.0005 m. An armature scaled as a whole moves
     * everything together and is not distortion.
     */
    bindPoseToleranceMeters: number;
    /** Two joints carry the same bind offset when every entry of their offset matrices agrees to this (matrix units, metres for the position). */
    offsetMatchMeters: number;
    /**
     * A file whose joints are in another order moves the vertices weighted to the misplaced joints, and those are
     * the ones counted, whatever share of the weight they carry (a rigid item all on one misplaced joint is 100%). At
     * errorShare of the mesh's vertices or more it fails; under it, it warns. In the calibration set the four real
     * cases are at 2.4% (a 28-vertex token earring beside a 1,131-vertex staff that is fine), 44%, 55% and 57%, the
     * last three all visibly deformed in the client. Giving 506 clean approved models that other order puts vertices
     * on misplaced joints in 501 of them: 499 are at 10% or more (three quarters at 100%), 2 are under it.
     */
    jointOrder: { errorShare: number };
    /** Standard poses the skeleton is put into. `local` poses move the arms, head or torso; the others move the legs, where skirts and gowns stretch by design. */
    poses: (SkinPose & { local: boolean })[];
    stretch: {
      /** An edge counts as stretched only when it also grows to at least this many times its bind-pose length. */
      minRatio: number;
      /** In a local pose, this many edges (localMinEdges) growing by at least localGrowthMeters warn: 3 of 516 approved models, three skins built on one body mesh, one of which a curator had sent back for it. */
      localGrowthMeters: number;
      localMinEdges: number;
      /**
       * This share of all edges (grossEdgeShare) growing by at least grossGrowthMeters fails in a local pose (the most on
       * 516 approved models is 1.05%, and only 3 are above 0) and warns in a leg pose (the most is 1.75%: gowns and
       * strapped trousers in a running stride).
       */
      grossGrowthMeters: number;
      grossEdgeShare: number;
    };
    /**
     * Weights on a mirror-symmetric mesh. A vertex has a mirror when another sits within mirrorToleranceMeters of its
     * reflection; vertices within centreBandMeters of the centre plane are their own mirror and are left out. A mesh
     * is symmetric when it has at least minVertices off-centre vertices and minMirroredShare of them have a mirror.
     * A pair differs when their weights, bone for mirrored bone, differ by at least minWeightDifference in total (2 =
     * nothing in common). 320 of 516 approved models are symmetric: 1 has more than warnShare of pairs differing
     * (14.7%, the next is 0.4%), so errorShare is never reached.
     */
    symmetry: {
      mirrorToleranceMeters: number; centreBandMeters: number; minVertices: number; minMirroredShare: number;
      minWeightDifference: number; warnShare: number; errorShare: number;
      /** Vertices one cell of the mirror search keeps (cells are mirrorToleranceMeters wide). It bounds the search on a file with thousands of vertices stacked on one point; no model of the calibration set changes its result at 16. */
      maxCellVertices: number;
    };
    /**
     * Items worn on the head: less than minWeightShare of their weight on the head bone (or bones under it) warns.
     * Approved items in these categories carry at least 57%, except 3 of 145 that are not head pieces at all.
     * earring, tiara and top_head are left out on purpose: approved items there are often worn elsewhere (wings,
     * tails, staffs, halos), with as little as 0% on the head.
     */
    headFollow: { bone: string; categories: string[]; minWeightShare: number };
  };
  /** V-01: how much of a capture must be something drawn. */
  renderValid: {
    /** Below this share of the frame a view counts as empty: the item draws nothing (an error, and the model checks skip it). */
    minSubjectRatio: number;
    /** Below this share an item that does draw is flagged to check (a small accessory, a thin band, or a model at the wrong scale). */
    warnSubjectRatio: number;
    /** Per channel: how far a pixel's red, green or blue may sit from its row's backdrop and still count as backdrop. */
    backgroundTolerance: number;
  };
  /** V-05. */
  thumbnailHonesty: { promptVersion: number; maxFindings: number };
  /** V-02/V-03/V-04/V-06 in one review of the wearable captures. */
  visualQuality: { promptVersion: number; maxFindings: number };
  /** V-07 over the emote captures. */
  emoteQuality: { promptVersion: number; maxFindings: number };
  /** S-12: one model call reads a smart wearable's code; its own input budget, since a bundle carries the SDK. Minified JS runs near 1.7 characters a token (DJ Cat: 372 KB, 219k tokens), so 1.5 MB fills most of the model's 1M-token context. */
  smartWearableCode: { promptVersion: number; maxFindings: number; maxCodeBytes: number; maxInputTokens: number };
  receipts: Record<string, string>;
}

export const manifest = manifestJson as unknown as Manifest;

const HAND_FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
function handFingerBones(side: "Left" | "Right"): string[] {
  return HAND_FINGERS.flatMap((finger) => [1, 2, 3, 4].map((segment) => `Avatar_${side}Hand${finger}${segment}`));
}

/** Canonical Decentraland avatar skeleton (62 deform bones). */
export const AVATAR_BONE_NAMES: string[] = [
  "Avatar_Hips", "Avatar_Spine", "Avatar_Spine1", "Avatar_Spine2", "Avatar_Neck", "Avatar_Head",
  "Avatar_LeftShoulder", "Avatar_LeftArm", "Avatar_LeftForeArm", "Avatar_LeftHand",
  ...handFingerBones("Left"),
  "Avatar_RightShoulder", "Avatar_RightArm", "Avatar_RightForeArm", "Avatar_RightHand",
  ...handFingerBones("Right"),
  "Avatar_LeftUpLeg", "Avatar_LeftLeg", "Avatar_LeftFoot", "Avatar_LeftToeBase",
  "Avatar_RightUpLeg", "Avatar_RightLeg", "Avatar_RightFoot", "Avatar_RightToeBase"
];
export const AVATAR_BONE_NAME_SET = new Set(AVATAR_BONE_NAMES);

/** Minimal required subset — a skeleton missing these is non-DCL, independent of optional fingers/toes. */
export const AVATAR_CORE_BONE_NAMES: string[] = [
  "Avatar_Hips", "Avatar_Spine", "Avatar_Neck", "Avatar_Head",
  "Avatar_LeftArm", "Avatar_LeftForeArm", "Avatar_LeftHand",
  "Avatar_RightArm", "Avatar_RightForeArm", "Avatar_RightHand",
  "Avatar_LeftUpLeg", "Avatar_LeftLeg", "Avatar_LeftFoot",
  "Avatar_RightUpLeg", "Avatar_RightLeg", "Avatar_RightFoot"
];

/**
 * The size ceiling an item is held to (ADR-246): every file counts, thumbnail and rarity image included. Emotes and
 * wearables share one ceiling; skins have their own.
 */
export function fileSizeLimit(itemType: "wearable" | "emote", category?: string): number {
  const sizes = manifest.fileSize;
  return itemType === "emote" ? sizes.emoteBytes : category === "skin" ? sizes.skinBytes : sizes.wearableBytes;
}

/**
 * effectiveLimit = base + Σ unique hides' budgets. Hiding the base hands adds their 500 (the docs' hands_wear
 * 1,000 → 1,500); hiding the head counts as hiding every head slot. A helmet, or anything hiding the head, tops out at
 * 4,000 (the docs' helmet rule).
 */
export function effectiveTriangleLimit(category: string, hides: string[] = []): number {
  const { perCategory, hiddenHandsBudget, headSlots, hiddenHeadLimit } = manifest.triangles;
  const hidesHead = hides.includes("head");
  const hidden = new Set(hidesHead ? [...hides, ...headSlots] : hides);
  hidden.delete(category);
  let limit = perCategory[category] ?? manifest.triangles.default;
  for (const slot of hidden) limit += slot === "hands" ? hiddenHandsBudget : perCategory[slot] ?? 0;
  return category === "helmet" || hidesHead ? Math.min(limit, hiddenHeadLimit) : limit;
}
