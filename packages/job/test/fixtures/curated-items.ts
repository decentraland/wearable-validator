/** An item as the dev job reported it on 2026-10-19 (both body shapes), worded for the 1024×1024 texture limit, for the Slack message tests. */
import type { ItemResult } from "../../src/logic/review-job.js";
import type { ReviewItem } from "../../src/logic/review-request.js";

const GLB = "bafybeidqfs5yyytcga4c53qt5upjzsokxkqqq47yk6janiqinow4ptbmwe.glb";
const both = <T extends { where?: string; message: string }>(make: (shape: "male" | "female") => T): T[] => [make("male"), make("female")];
const docs = "https://docs.example";

export const dinoSkin: ReviewItem = {
  itemId: "1b4d9c47-2278-40c9-8500-812571f7267d",
  contentHash: "bafkreicwfrihbmop2jc7e5gqw2nywol3h3itlxo7ba4skzd4svxjvyq6yy",
  itemType: "wearable",
  metadata: { name: "Dino Skin" },
  contents: { [`male/${GLB}`]: "bafy1", [`female/${GLB}`]: "bafy1", "thumbnail.png": "bafy2" }
};

const tooLarge = (texture: string, size: number) =>
  both((shape) => ({ rule: "M-03", check: "texture-size", severity: "error" as const, message: `"${shape}/${GLB}" › ${texture} is ${size}×${size}; the maximum texture size is 1024×1024. Resize it to 1024×1024 or smaller.`, where: `"${shape}/${GLB}" › ${texture}`, bodyShape: shape, docs }));

export const dinoSkinResult: ItemResult = {
  itemId: dinoSkin.itemId,
  contentHash: dinoSkin.contentHash,
  passed: false,
  visualSummary: "thumbnail-honesty: Compared the thumbnail with 12 rendered views. It matches.\nvisual-quality: Reviewed 20 rendered views. No defects.",
  findings: [
    ...both((shape) => ({ rule: "M-02", check: "texture-count", severity: "error" as const, message: `"${shape}/${GLB}" references 5 texture images; the limit is 2. Merge the images into a texture atlas so the model uses at most 2.`, where: `${shape}/${GLB}`, bodyShape: shape, measured: 5, limit: 2, docs })),
    ...tooLarge("Image_0", 2048),
    ...tooLarge("lips2", 2048),
    ...tooLarge("PETAVERSE_ICON_BLACK_FF", 5001),
    ...both((shape) => ({ rule: "M-03", check: "texture-size", severity: "warning" as const, message: `"${shape}/${GLB}" › PETAVERSE_ICON_BLACK_FF is 5001×5001, which is not a power of two — GPUs handle sizes like 512×512 or 1024×1024 far better. Resize to the nearest power of two.`, where: `"${shape}/${GLB}" › PETAVERSE_ICON_BLACK_FF`, bodyShape: shape, docs })),
    ...both((shape) => ({ rule: "M-06", check: "material-count", severity: "error" as const, message: `"${shape}/${GLB}" uses 11 materials; the limit is 2 (AvatarSkin_MAT excluded). Merge meshes so they share at most 2 materials.`, where: `${shape}/${GLB}`, bodyShape: shape, measured: 11, limit: 2, docs })),
    ...both((shape) => ({ rule: "F-04", check: "qr-code", severity: "warning" as const, message: `Texture "PETAVERSE_ICON_BLACK_FF" in "${shape}/${GLB}" is 5001×5001 — too large to scan for QR codes (the scanner reads images up to 16.8 megapixels). Shrink it to the texture and thumbnail size limits so it can be checked.`, where: `"${shape}/${GLB}" › PETAVERSE_ICON_BLACK_FF`, bodyShape: shape, docs }))
  ]
};
