import manifestJson from "./manifest.json" with { type: "json" };

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
  /**
   * D-01: an upload against the published catalog, calibrated on the 11,231 approved items of Nov 2026 (10,594 comparable):
   * at warnShare 0.85, 795 match an earlier item by another creator, 46 of them from the last 12 months.
   */
  similarItems: {
    /** Position signal: the grid a vertex is snapped to. 2 and 4 mm found nothing 1 mm missed. */
    gridMillimeters: number;
    /** Own cells a model needs for the position signal: fewer match by accident. */
    minCells: number;
    /** A connected part needs this many triangles and this many different corner-valence triples for its shape to mean anything (a UV sphere has 4). */
    minPartTriangles: number; minPartKinds: number;
    /** Triangles in such parts a model needs for the shape signal. */
    minTriangles: number;
    /** Two parts with the same signature are the same shape when both axis ratios agree within this. */
    ratioTolerance: number;
    /** Geometry in the items of this many creators is nobody's (the reference body): removed before comparing. */
    commonCreators: number;
    /** Warn when this share of the upload's own geometry is in a published item. */
    warnShare: number;
    /** Warn when this share of a published item sits inside the upload. */
    containsShare: number;
    /** Geometry already published by this many creators is a shared template: no warning (decided Nov 2026). */
    templateCreators: number;
    /** Warnings one item can get from this check, in all. */
    maxFindings: number;
    /** Vertices closer than this are one vertex when a mesh's parts are found: exporters split a vertex per UV seam and per normal. */
    weldMillimeters: number;
    /** Indices (vertices, without indices) plus skin joints a model may make the fingerprint read (a mesh reused by several nodes counts each time) before the check declines: about 10 times the largest model in the approved catalog (14,698 vertices). */
    maxElements: number;
    /** Models compared per lookup: an item has one per body shape. */
    maxModels: number;
  };
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
