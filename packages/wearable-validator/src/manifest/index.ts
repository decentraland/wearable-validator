import manifestJson from "./manifest.json" with { type: "json" };

export interface Manifest {
  version: string;
  triangles: { default: number; perCategory: Record<string, number>; handsWearHiddenHandsLimit: number; helmetHiddenHeadLimit: number };
  textures: { default: number; skin: number; maxSize: number; facialMaxSize: number };
  materials: { default: number; skin: number; avatarSkinMat: string; forbiddenMeshNamePatterns: string[] };
  facialCategories: string[];
  fileSize: {
    wearableBytes: number; skinBytes: number; emoteBytes: number; modelHeadroomBytes: number;
    thumbnailBytes: number; thumbnailMaxSize: number; thumbnailRecommendedSize: number;
    smartWearableVideoBytes: number; audioBytes: number; maxInputBytes: number;
    /** Zip bounds, checked against the declared sizes before inflating and against the real bytes while inflating. */
    maxEntries: number; maxUncompressedBytes: number; maxEntryUncompressedBytes: number;
  };
  /** Header width × height above which no check decodes an image to pixels (a decoded image costs at least 4 bytes per pixel). */
  images: {
    maxDecodePixels: number; inflateChunkBytes: number;
    /** Pixels the QR scan decodes across all of an item's textures: many texture entries can point at the same bytes. */
    maxScanPixels: number;
  };
  boundingBox: { width: number; height: number; depth: number };
  /** ADR-60 auto-hide set — the categories a skin is expected to hide. */
  skinAutoHideSet: string[];
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
    rootMotion: { horizontalErrorMeters: number; verticalWarnMeters: number; verticalErrorMeters: number; hipsPattern: string };
    maxSocialOutcomes: number;
  };
  epsilons: { loopSeamTranslation: number; loopSeamQuaternionDot: number; loopSeamScale: number; zUpRotationToleranceDegrees: number };
  gltf: {
    extensionAllowlist: string[]; unknownCodeSeverity: string; severityOverrides: Record<string, string>;
    /** Accessors (count × element size) plus embedded images (their buffer view): what parsing a model allocates, checked before it does. */
    maxUnpackedBytes: number;
  };
  hands: { minHandWeightRatio: number };
  thumbnail: { minTransparentPixelRatio: number; alphaThreshold: number };
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
  /** V-01: how much of a capture must be something drawn. */
  renderValid: { minSubjectRatio: number; backgroundTolerance: number };
  /** V-05. */
  thumbnailHonesty: { promptVersion: number; maxFindings: number };
  /** V-02/V-03/V-04/V-06 in one review of the wearable captures. */
  visualQuality: { promptVersion: number; maxFindings: number };
  /** V-07 over the emote captures. */
  emoteQuality: { promptVersion: number; maxFindings: number };
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

/** effectiveLimit = base + Σ unique hides' budgets; hands_wear base bumps to 1,500 when hiding 'hands'; a helmet tops out at 4,000 however many head slots it hides (the docs' helmet rule). */
export function effectiveTriangleLimit(category: string, hides: string[] = []): number {
  const uniqueHides = [...new Set(hides)];
  let base = manifest.triangles.perCategory[category] ?? manifest.triangles.default;
  if (category === "hands_wear" && uniqueHides.includes("hands")) base = manifest.triangles.handsWearHiddenHandsLimit;
  let limit = base;
  for (const hidden of uniqueHides) {
    limit += manifest.triangles.perCategory[hidden] ?? 0;
  }
  return category === "helmet" ? Math.min(limit, manifest.triangles.helmetHiddenHeadLimit) : limit;
}
