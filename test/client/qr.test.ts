// Spec 16 D4: correctness coverage for the hand-rolled QR encoder
// (src/client/lib/qr.ts). No `qrcode` npm dependency was available (no
// network in this worktree), so this test doesn't just check "a matrix came
// out" — it independently DECODES the encoder's own output (reads the
// format-info mask id back off the matrix, undoes that exact mask, walks the
// same zigzag column order the encoder used, and reassembles the byte-mode
// segment) and asserts the decoded text matches the input. That's the
// closest thing to "a real scanner would read this" that's checkable without
// a camera or an external library.
import { describe, expect, test } from "vitest";
import { encodeQr } from "../../src/client/lib/qr";

// --- minimal independent decode path -------------------------------------

function applyMaskLocal(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("bad mask");
  }
}

// Reads the 15-bit format info from the (redundant) top-left copy and
// extracts the 3-bit mask id (bits 2-4 of the un-masked format string, per
// ISO/IEC 18004 fig 25) by brute-force matching against the same
// EC-level-M table the encoder used — simplest reliable route without
// reimplementing BCH error correction for a test.
const FORMAT_INFO_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

function readFormatMask(modules: boolean[][]): number {
  // Mirrors `placeFormatInfo`'s write order exactly (bit 0 first), then
  // reassembles MSB-first to match `FORMAT_INFO_M`'s encoding.
  const bitAt: (boolean | undefined)[] = [];
  for (let i = 0; i <= 5; i++) bitAt[i] = modules[8]![i];
  bitAt[6] = modules[8]![7];
  bitAt[7] = modules[8]![8];
  bitAt[8] = modules[7]![8];
  for (let i = 9; i <= 14; i++) bitAt[i] = modules[14 - i]![8];

  let bits = 0;
  for (let i = 14; i >= 0; i--) bits = (bits << 1) | (bitAt[i] ? 1 : 0);
  const known = FORMAT_INFO_M.findIndex((f) => f === bits);
  expect(known).toBeGreaterThanOrEqual(0);
  return known;
}

function isFunctionModule(size: number, x: number, y: number, alignmentCoords: number[]): boolean {
  // Finder + separator (9x9 corners).
  if ((x < 9 && y < 9) || (x < 9 && y >= size - 8) || (x >= size - 8 && y < 9)) return true;
  // Timing lines.
  if (x === 6 || y === 6) return true;
  // Dark module + format areas already covered by finder corners; alignment:
  for (const cy of alignmentCoords) {
    for (const cx of alignmentCoords) {
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  }
  return false;
}

const ALIGNMENT_COORDS: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 48], 10: [6, 28, 52],
};

// Mirrors qr.ts's VERSION_TABLE (block/EC layout) — needed to de-interleave:
// for multi-block versions, the physically-drawn codeword stream alternates
// data codewords across blocks (then all EC codewords), so the mode/length/
// payload bit fields can only be parsed correctly AFTER reassembling each
// block's data codewords back into sequential block order (block 0 in full,
// then block 1 in full, ...) — reading the interleaved stream as if it were
// sequential silently pulls the wrong bits into the character-count field
// the moment a version has more than one block (version 8+ at level M, or
// once a payload is long enough to need it).
const BLOCK_LAYOUT: Record<number, { blocksGroup1: number; dataPerBlockGroup1: number; blocksGroup2: number; dataPerBlockGroup2: number }> = {
  1: { blocksGroup1: 1, dataPerBlockGroup1: 16, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  2: { blocksGroup1: 1, dataPerBlockGroup1: 28, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  3: { blocksGroup1: 1, dataPerBlockGroup1: 44, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  4: { blocksGroup1: 2, dataPerBlockGroup1: 32, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  5: { blocksGroup1: 2, dataPerBlockGroup1: 43, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  6: { blocksGroup1: 4, dataPerBlockGroup1: 27, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  7: { blocksGroup1: 4, dataPerBlockGroup1: 31, blocksGroup2: 0, dataPerBlockGroup2: 0 },
  8: { blocksGroup1: 2, dataPerBlockGroup1: 38, blocksGroup2: 2, dataPerBlockGroup2: 39 },
  9: { blocksGroup1: 3, dataPerBlockGroup1: 36, blocksGroup2: 2, dataPerBlockGroup2: 37 },
  10: { blocksGroup1: 4, dataPerBlockGroup1: 43, blocksGroup2: 1, dataPerBlockGroup2: 44 },
};

/** Un-does the encoder's `interleave()`: given the codewords in the order
 * they were physically drawn (data codewords round-robin across blocks,
 * then EC codewords round-robin across blocks), reassembles just the data
 * portion back into sequential block-0-then-block-1-... order. */
function deinterleaveData(interleaved: number[], version: number): number[] {
  const layout = BLOCK_LAYOUT[version]!;
  const blockSizes = [
    ...Array(layout.blocksGroup1).fill(layout.dataPerBlockGroup1),
    ...Array(layout.blocksGroup2).fill(layout.dataPerBlockGroup2),
  ];
  const blocks: number[][] = blockSizes.map(() => []);
  const maxLen = Math.max(...blockSizes);
  let idx = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blockSizes[b]!) blocks[b]!.push(interleaved[idx++]!);
    }
  }
  return blocks.flat();
}

/** Walks the same zigzag data path the encoder used and returns the raw
 * (unmasked) bit sequence in placement order. */
function readDataBits(modules: boolean[][], mask: number, alignmentCoords: number[]): boolean[] {
  const size = modules.length;
  const bits: boolean[] = [];
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (isFunctionModule(size, x, y, alignmentCoords)) continue;
        const raw = modules[y]![x]!;
        const unmasked = applyMaskLocal(mask, x, y) ? !raw : raw;
        bits.push(unmasked);
      }
    }
    upward = !upward;
    col -= 2;
  }
  return bits;
}

function bitsToNumber(bits: boolean[], start: number, len: number): number {
  let n = 0;
  for (let i = 0; i < len; i++) n = (n << 1) | (bits[start + i] ? 1 : 0);
  return n;
}

/** Decodes a byte-mode-only QR matrix back to its original string, given the
 * version's data-codeword capacity (so it knows how many codewords are data
 * vs. error-correction — decoding doesn't need the EC bytes since these
 * fixtures are generated fresh with no corruption). */
function decodeByteModeText(matrix: { size: number; modules: boolean[][] }): string {
  const version = (matrix.size - 17) / 4;
  const alignmentCoords = ALIGNMENT_COORDS[version] ?? [];
  const mask = readFormatMask(matrix.modules);
  const rawBits = readDataBits(matrix.modules, mask, alignmentCoords);

  // Regroup into codewords (physical/interleaved order), keep only the data
  // codewords (drop trailing EC codewords and any ISO remainder bits), then
  // de-interleave back to sequential block order before parsing bit fields.
  const layout = BLOCK_LAYOUT[version]!;
  const totalDataCodewords =
    layout.blocksGroup1 * layout.dataPerBlockGroup1 + layout.blocksGroup2 * layout.dataPerBlockGroup2;
  const interleavedDataCodewords: number[] = [];
  for (let i = 0; i < totalDataCodewords; i++) {
    interleavedDataCodewords.push(bitsToNumber(rawBits, i * 8, 8));
  }
  const dataCodewords = deinterleaveData(interleavedDataCodewords, version);
  const bits: boolean[] = [];
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) === 1);
  }

  const modeIndicator = bitsToNumber(bits, 0, 4);
  expect(modeIndicator).toBe(0b0100); // byte mode
  const ccBits = version <= 9 ? 8 : 16;
  const byteLength = bitsToNumber(bits, 4, ccBits);
  const dataStart = 4 + ccBits;

  const out: number[] = [];
  for (let i = 0; i < byteLength; i++) {
    out.push(bitsToNumber(bits, dataStart + i * 8, 8));
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

// ---------------------------------------------------------------------------

describe("encodeQr", () => {
  test("round-trips a short room URL", () => {
    const text = "https://mafia.tannerwj.com/room/ABCDE";
    const matrix = encodeQr(text);
    expect(decodeByteModeText(matrix)).toBe(text);
  });

  test("round-trips a longer URL (forces a higher version)", () => {
    const text = "https://mafia.tannerwj.com/room/ABCDE?utm_source=host-lobby-qr-share-surface";
    const matrix = encodeQr(text);
    expect(decodeByteModeText(matrix)).toBe(text);
  });

  test("round-trips the shortest plausible input", () => {
    const text = "https://mafia.tannerwj.com/room/A";
    const matrix = encodeQr(text);
    expect(decodeByteModeText(matrix)).toBe(text);
  });

  test("matrix size follows version formula and stays square", () => {
    const matrix = encodeQr("https://mafia.tannerwj.com/room/ABCDE");
    expect(matrix.modules.length).toBe(matrix.size);
    for (const row of matrix.modules) expect(row.length).toBe(matrix.size);
    // version 1 (21x21) comfortably fits a ~38-char URL at EC level M.
    expect(matrix.size).toBeGreaterThanOrEqual(21);
  });

  test("finder patterns present in all three corners", () => {
    const matrix = encodeQr("https://mafia.tannerwj.com/room/ABCDE");
    const { modules, size } = matrix;
    // Center of each finder pattern's 3x3 core is always dark.
    expect(modules[3]![3]).toBe(true);
    expect(modules[3]![size - 4]).toBe(true);
    expect(modules[size - 4]![3]).toBe(true);
  });

  test("round-trips a payload long enough to require two block groups (version 8+)", () => {
    // Version 8 (level M) is the first version with a second block group of
    // a different size (2 blocks of 38 + 2 blocks of 39) — the interleave
    // branch our room-URL payloads never exercise in practice, but worth
    // pinning since it's a distinct code path from the single-group case.
    const text = "https://mafia.tannerwj.com/room/ABCDE?" + "x".repeat(110);
    const matrix = encodeQr(text);
    expect((matrix.size - 17) / 4).toBeGreaterThanOrEqual(8);
    expect(decodeByteModeText(matrix)).toBe(text);
  });

  test("throws on input that exceeds version-10 byte-mode capacity", () => {
    expect(() => encodeQr("x".repeat(300))).toThrow();
  });
});
