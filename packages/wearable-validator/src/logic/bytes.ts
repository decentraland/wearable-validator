/** Byte-count formatting shared by the size-limit checks. */

/** Bytes → MiB rounded to two decimals, as creators read limits. */
export const mb = (n: number): number => Math.round((n / 1048576) * 100) / 100;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The item's size as the catalyst counts it: identical files (one hash, as male/ and female/ copies often are) once. */
export function uniqueBytesTotal(files: Iterable<Uint8Array>): number {
  const seen = new Map<number, Uint8Array[]>();
  let total = 0;
  for (const bytes of files) {
    const sameLength = seen.get(bytes.length) ?? [];
    if (sameLength.some((other) => sameBytes(other, bytes))) continue;
    sameLength.push(bytes);
    seen.set(bytes.length, sameLength);
    total += bytes.length;
  }
  return total;
}
