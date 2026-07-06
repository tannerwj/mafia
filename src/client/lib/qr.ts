// Spec 16 D4: a self-contained QR code encoder (no dependency — orchestrator
// has no network access to install packages, and the room URL fits
// comfortably in byte mode at a low version, so hand-rolling avoids a
// dependency for a well-defined, testable algorithm).
//
// Scope: byte mode only (our payload is always an ASCII URL), error
// correction level M, versions 1-10 (up to 213 bytes of ASCII at level M —
// far more than `https://mafia.tannerwj.com/room/ABCDE` needs). This is NOT
// a general QR library: no kanji/alphanumeric mode, no ECI, no version >10.
//
// Implementation follows ISO/IEC 18004: Reed-Solomon error correction over
// GF(256), the standard version-1..10 capacity/EC tables, all 8 mask
// patterns scored by the standard penalty rules, and the fixed function
// patterns (finder, separator, timing, alignment per version, dark module,
// format info). Output is a square boolean matrix (`true` = dark module) for
// the caller to render (canvas/SVG) — this module does no drawing.

export interface QrMatrix {
  size: number;
  /** Row-major; `modules[y][x] === true` means a dark (black) module. */
  modules: boolean[][];
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic (ISO/IEC 18004 primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11d)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon generator polynomial of given degree, coefficients highest-first. */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j]!, 1);
      next[j + 1] ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecCount: number): number[] {
  const generator = rsGeneratorPoly(ecCount);
  const remainder = new Array(ecCount).fill(0);
  for (const b of data) {
    const factor = b ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < generator.length; i++) {
        remainder[i] = (remainder[i] ?? 0) ^ gfMul(generator[i]!, factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Version tables: versions 1-10, error correction level M only (spec's
// stated need — a room URL is well under version 10's capacity).
// [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, numBlocksGroup2]
// Group 2 blocks (if any) carry one more data codeword than group 1 — this
// only starts mattering above version 5 at level M; kept general anyway.
// ---------------------------------------------------------------------------

interface VersionInfo {
  version: number;
  totalCodewords: number;
  ecCodewordsPerBlock: number;
  blocksGroup1: number;
  dataPerBlockGroup1: number;
  blocksGroup2: number;
  dataPerBlockGroup2: number;
  alignmentCoords: number[];
}

// Source: ISO/IEC 18004 Table 9 (EC level M), Table E.1 (alignment patterns).
const VERSION_TABLE: Record<number, Omit<VersionInfo, "version" | "alignmentCoords">> = {
  1: { totalCodewords: 26, ecCodewordsPerBlock: 10, blocksGroup1: 1, dataPerBlockGroup1: 16, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  2: { totalCodewords: 44, ecCodewordsPerBlock: 16, blocksGroup1: 1, dataPerBlockGroup1: 28, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  3: { totalCodewords: 70, ecCodewordsPerBlock: 26, blocksGroup1: 1, dataPerBlockGroup1: 44, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  4: { totalCodewords: 100, ecCodewordsPerBlock: 18, blocksGroup1: 2, dataPerBlockGroup1: 32, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  5: { totalCodewords: 134, ecCodewordsPerBlock: 24, blocksGroup1: 2, dataPerBlockGroup1: 43, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  6: { totalCodewords: 172, ecCodewordsPerBlock: 16, blocksGroup1: 4, dataPerBlockGroup1: 27, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  7: { totalCodewords: 196, ecCodewordsPerBlock: 18, blocksGroup1: 4, dataPerBlockGroup1: 31, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  8: { totalCodewords: 242, ecCodewordsPerBlock: 22, blocksGroup1: 2, dataPerBlockGroup1: 38, blocksGroup2: 2, dataPerBlockGroup2: 39 },
  9: { totalCodewords: 292, ecCodewordsPerBlock: 22, blocksGroup1: 3, dataPerBlockGroup1: 36, blocksGroup2: 2, dataPerBlockGroup2: 37 },
  10: { totalCodewords: 346, ecCodewordsPerBlock: 26, blocksGroup1: 4, dataPerBlockGroup1: 43, blocksGroup2: 1, dataPerBlockGroup2: 44 },
};

const ALIGNMENT_COORDS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 48],
  10: [6, 28, 52],
};

function versionInfo(version: number): VersionInfo {
  const base = VERSION_TABLE[version];
  if (!base) throw new Error(`qr: unsupported version ${version} (max 10)`);
  return { version, alignmentCoords: ALIGNMENT_COORDS[version]!, ...base };
}

function totalDataCodewords(v: VersionInfo): number {
  return v.blocksGroup1 * v.dataPerBlockGroup1 + v.blocksGroup2 * v.dataPerBlockGroup2;
}

/** Smallest version (1-10) whose byte-mode capacity (at EC level M) fits `byteLength`. */
function pickVersion(byteLength: number): VersionInfo {
  for (let v = 1; v <= 10; v++) {
    const info = versionInfo(v);
    // Byte mode: 4-bit mode indicator + character count indicator (8 bits for
    // versions 1-9, 16 bits for version 10+) + 8 bits per data byte.
    const ccBits = v <= 9 ? 8 : 16;
    const headerBits = 4 + ccBits;
    const capacityBits = totalDataCodewords(info) * 8;
    const capacityBytes = Math.floor((capacityBits - headerBits) / 8);
    if (byteLength <= capacityBytes) return info;
  }
  throw new Error(`qr: input too long for versions 1-10 (${byteLength} bytes)`);
}

// ---------------------------------------------------------------------------
// Bit buffer
// ---------------------------------------------------------------------------

class BitBuffer {
  private bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length(): number {
    return this.bits.length;
  }
  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

function buildDataCodewords(text: string, v: VersionInfo): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode indicator
  const ccBits = v.version <= 9 ? 8 : 16;
  buf.put(bytes.length, ccBits);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = totalDataCodewords(v) * 8;
  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const termBits = Math.min(4, capacityBits - buf.length);
  if (termBits > 0) buf.put(0, termBits);
  while (buf.length % 8 !== 0) buf.put(0, 1);

  const codewords = buf.toBytes();
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < totalDataCodewords(v)) {
    codewords.push(padBytes[padIndex % 2]!);
    padIndex++;
  }
  return codewords;
}

function interleave(dataCodewords: number[], v: VersionInfo): number[] {
  const g1Blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < v.blocksGroup1; i++) {
    g1Blocks.push(dataCodewords.slice(offset, offset + v.dataPerBlockGroup1));
    offset += v.dataPerBlockGroup1;
  }
  const g2Blocks: number[][] = [];
  for (let i = 0; i < v.blocksGroup2; i++) {
    g2Blocks.push(dataCodewords.slice(offset, offset + v.dataPerBlockGroup2));
    offset += v.dataPerBlockGroup2;
  }
  const allBlocks = [...g1Blocks, ...g2Blocks];
  const ecBlocks = allBlocks.map((block) => rsEncode(block, v.ecCodewordsPerBlock));

  const result: number[] = [];
  const maxDataLen = Math.max(v.dataPerBlockGroup1, v.dataPerBlockGroup2 || 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of allBlocks) {
      if (i < block.length) result.push(block[i]!);
    }
  }
  for (let i = 0; i < v.ecCodewordsPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i]!);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

const FORMAT_INFO_M = [
  // Precomputed (EC level M = 0b00) 15-bit format strings for mask 0-7,
  // BCH(15,5) encoded + XORed with 0x5412, per ISO/IEC 18004 Annex C.
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function newModuleGrid(size: number): (boolean | null)[][] {
  return Array.from({ length: size }, () => new Array(size).fill(null) as (boolean | null)[]);
}

function placeFinder(grid: (boolean | null)[][], top: number, left: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const y = top + dy;
      const x = left + dx;
      if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue;
      const inRing = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6 && (dy === 0 || dy === 6 || dx === 0 || dx === 6);
      const inCore = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
      grid[y]![x] = inRing || inCore;
    }
  }
}

function placeTiming(grid: (boolean | null)[][]): void {
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    if (grid[6]![i] === null) grid[6]![i] = i % 2 === 0;
    if (grid[i]![6] === null) grid[i]![6] = i % 2 === 0;
  }
}

function placeAlignmentPatterns(grid: (boolean | null)[][], coords: number[]): void {
  const size = grid.length;
  for (const cy of coords) {
    for (const cx of coords) {
      // Skip positions overlapping the three finder patterns.
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dy), Math.abs(dx));
          grid[cy + dy]![cx + dx] = ring !== 1;
        }
      }
    }
  }
}

function placeDarkModule(grid: (boolean | null)[][], version: number): void {
  grid[4 * version + 9]![8] = true;
}

function reserveFormatAreas(grid: (boolean | null)[][]): void {
  const size = grid.length;
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8]![size - 1 - i] === null) grid[8]![size - 1 - i] = false;
    if (grid[size - 1 - i]![8] === null) grid[size - 1 - i]![8] = false;
  }
}

function applyMask(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error(`qr: invalid mask ${mask}`);
  }
}

function placeData(grid: (boolean | null)[][], codewords: number[], mask: number): boolean[][] {
  const size = grid.length;
  const bits: boolean[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) === 1);
  }

  const out: boolean[][] = grid.map((row) => row.map((v) => v === true));
  const isFree = grid.map((row) => row.map((v) => v === null));

  let bitIndex = 0;
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (!isFree[y]![x]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex]! : false;
        const masked = applyMask(mask, x, y) ? !bit : bit;
        out[y]![x] = masked;
        bitIndex++;
      }
    }
    upward = !upward;
    col -= 2;
  }
  return out;
}

function placeFormatInfo(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = FORMAT_INFO_M[mask]!;
  const bit = (i: number) => ((bits >> i) & 1) === 1;

  // Around top-left finder.
  for (let i = 0; i <= 5; i++) modules[8]![i] = bit(i);
  modules[8]![7] = bit(6);
  modules[8]![8] = bit(7);
  modules[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) modules[14 - i]![8] = bit(i);

  // Top-right + bottom-left copies.
  for (let i = 0; i <= 7; i++) modules[size - 1 - i]![8] = bit(i);
  for (let i = 8; i <= 14; i++) modules[8]![size - 15 + i] = bit(i);
}

const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // Rule 1: runs of 5+ same-color modules in a row/column.
  for (let y = 0; y < size; y++) {
    let runLen = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y]![x] === modules[y]![x - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) score += N1 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += N1 + (runLen - 5);
  }
  for (let x = 0; x < size; x++) {
    let runLen = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y]![x] === modules[y - 1]![x]) {
        runLen++;
      } else {
        if (runLen >= 5) score += N1 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += N1 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y]![x];
      if (v === modules[y]![x + 1] && v === modules[y + 1]![x] && v === modules[y + 1]![x + 1]) {
        score += N2;
      }
    }
  }

  // Rule 3: finder-like patterns (1:1:3:1:1 with 4 light either side).
  const pattern = [true, false, true, true, true, false, true];
  const checkLine = (get: (i: number) => boolean, len: number) => {
    for (let i = 0; i <= len - 7; i++) {
      let matches = true;
      for (let j = 0; j < 7; j++) {
        if (get(i + j) !== pattern[j]) { matches = false; break; }
      }
      if (!matches) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((d) => get(i - d) === false);
      const lightAfter = i + 7 + 3 < len && [0, 1, 2, 3].every((d) => get(i + 7 + d) === false);
      if (lightBefore || lightAfter) score += N3;
    }
  };
  for (let y = 0; y < size; y++) checkLine((i) => modules[y]![i]!, size);
  for (let x = 0; x < size; x++) checkLine((i) => modules[i]![x]!, size);

  // Rule 4: overall dark/light balance.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y]![x]) dark++;
  const percent = (dark * 100) / (size * size);
  const deviation = Math.abs(Math.floor(percent / 5) * 5 - 50) / 5;
  score += deviation * N4;

  return score;
}

/**
 * Encode `text` (ASCII/UTF-8 byte mode) as a QR matrix at error correction
 * level M, auto-selecting the smallest supported version (1-10) that fits.
 */
export function encodeQr(text: string): QrMatrix {
  const byteLength = new TextEncoder().encode(text).length;
  const v = pickVersion(byteLength);
  const dataCodewords = buildDataCodewords(text, v);
  const allCodewords = interleave(dataCodewords, v);

  const size = v.version * 4 + 17;
  const grid = newModuleGrid(size);
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  placeTiming(grid);
  placeAlignmentPatterns(grid, v.alignmentCoords);
  placeDarkModule(grid, v.version);
  reserveFormatAreas(grid);

  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = placeData(grid, allCodewords, mask);
    placeFormatInfo(modules, mask);
    const score = penaltyScore(modules);
    if (!best || score < best.score) best = { mask, modules, score };
  }

  return { size, modules: best!.modules };
}
