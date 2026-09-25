// Decentraland content hashes on the platform's own Web Crypto (browsers and Node alike), so no bundler needs a Node
// `crypto` polyfill. Outputs match @dcl/hashing 3.0.4, which content-hash.test.ts checks across chunk and tree edges:
// "Qm…" is the CIDv0 of the whole file's SHA-256; "bafk…"/"bafy…" is the CIDv1 of the UnixFS DAG ipfs-unixfs-importer
// builds with raw leaves: 256 KiB chunks, a balanced tree of at most 174 links per node, one chunk reduced to itself.
const CHUNK_BYTES = 262144;
const MAX_LINKS = 174;
const RAW = 0x55;
const DAG_PB = 0x70;
const SHA2_256 = 0x12;

interface DagNode {
  cid: Uint8Array;
  fileSize: number;
  /** Bytes of this block plus every block under it: the Tsize a parent's link records. */
  treeSize: number;
  single?: boolean;
}

export async function contentHash(bytes: Uint8Array, version: 0 | 1 = 1): Promise<string> {
  if (version === 0) return base58btc(multihash(await sha256(bytes)));
  const leaves: DagNode[] = [];
  for (let offset = 0; offset < bytes.length || leaves.length === 0; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    leaves.push({ cid: cidV1(RAW, await sha256(chunk)), fileSize: chunk.length, treeSize: chunk.length });
  }
  leaves[0].single = leaves.length === 1;
  let level = leaves;
  do {
    const parents: DagNode[] = [];
    for (let i = 0; i < level.length; i += MAX_LINKS) parents.push(await reduce(level.slice(i, i + MAX_LINKS)));
    level = parents;
  } while (level.length > 1);
  return "b" + base32(level[0].cid);
}

async function reduce(children: DagNode[]): Promise<DagNode> {
  if (children.length === 1 && children[0].single) return children[0];
  const fileSize = children.reduce((total, child) => total + child.fileSize, 0);
  // UnixFS Data: Type = file, filesize, one blocksizes entry per child; dag-pb writes its Links before its Data
  const unixfs = concat([varintField(1, 2), varintField(3, fileSize), ...children.map((child) => varintField(4, child.fileSize))]);
  const links = children.map((child) => bytesField(2, concat([bytesField(1, child.cid), bytesField(2, new Uint8Array(0)), varintField(3, child.treeSize)])));
  const block = concat([...links, bytesField(1, unixfs)]);
  const treeSize = block.length + children.reduce((total, child) => total + child.treeSize, 0);
  return { cid: cidV1(DAG_PB, await sha256(block)), fileSize, treeSize };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Web Crypto takes views over plain ArrayBuffers only
  const view = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
  return new Uint8Array(await crypto.subtle.digest("SHA-256", view));
}

const multihash = (digest: Uint8Array): Uint8Array => concat([Uint8Array.of(SHA2_256, digest.length), digest]);
const cidV1 = (codec: number, digest: Uint8Array): Uint8Array => concat([Uint8Array.of(1, codec), multihash(digest)]);

function varint(value: number): Uint8Array {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
  return Uint8Array.from(out);
}

const varintField = (field: number, value: number): Uint8Array => concat([varint(field << 3), varint(value)]);
const bytesField = (field: number, value: Uint8Array): Uint8Array => concat([varint((field << 3) | 2), varint(value.length), value]);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

function base58btc(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]];
  return out;
}
