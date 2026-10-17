/**
 * Generate app icons for Token Watcher.
 *
 * Creates a 512x512 PNG with a "TW" monogram on a blue gradient background.
 * electron-builder will auto-generate .icns (macOS) and .ico (Windows) from this PNG.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
const iconPath = join(buildDir, "icon.png");
const iconsDir = join(buildDir, "icons");

const SIZE = 512;

// =============================================================================
// PNG encoder (minimal, no dependencies)
// =============================================================================

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPng(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk("IHDR", ihdr);

  // IDAT chunk (raw pixel data with filter byte per row)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawData.push(pixels[idx]); // R
      rawData.push(pixels[idx + 1]); // G
      rawData.push(pixels[idx + 2]); // B
      rawData.push(pixels[idx + 3]); // A
    }
  }

  // Simple deflate (store method, no compression — good enough for build tool)
  const deflated = deflateRaw(Buffer.from(rawData));
  const idatChunk = createChunk("IDAT", deflated);

  // IEND chunk
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcValue = Buffer.alloc(4);
  crcValue.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crcValue]);
}

function deflateRaw(data) {
  // Minimal deflate "stored" block (no compression)
  // This is valid for PNG and works without zlib dependency
  const chunks = [];
  const MAX_BLOCK = 65535;

  for (let offset = 0; offset < data.length; offset += MAX_BLOCK) {
    const blockSize = Math.min(MAX_BLOCK, data.length - offset);
    const isLast = offset + blockSize >= data.length;

    // Block header: BFINAL (1 bit) + BTYPE=00 (2 bits) = 0x00 or 0x01
    chunks.push(isLast ? 0x01 : 0x00);

    // LEN and NLEN (2 bytes each, little-endian)
    const len = Buffer.alloc(2);
    len.writeUInt16LE(blockSize, 0);
    const nlen = Buffer.alloc(2);
    nlen.writeUInt16LE(blockSize ^ 0xffff, 0);

    chunks.push(len[0], len[1], nlen[0], nlen[1]);

    // Data
    for (let i = offset; i < offset + blockSize; i++) {
      chunks.push(data[i]);
    }
  }

  // zlib header (CMF=0x78, FLG=0x01) + blocks + adler32 checksum
  const adler = adler32(data);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler, 0);

  return Buffer.from([0x78, 0x01, ...chunks, adlerBuf[0], adlerBuf[1], adlerBuf[2], adlerBuf[3]]);
}

function adler32(data) {
  let a = 1,
    b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// =============================================================================
// Icon design
// =============================================================================

function createIconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded rect background
      const cornerRadius = size * 0.2;
      const inRect = isInRoundedRect(x, y, size, size, cornerRadius);

      if (inRect) {
        // Gradient background (blue-purple)
        const t = y / size;
        pixels[idx] = Math.round(60 + t * 40); // R
        pixels[idx + 1] = Math.round(100 + t * 40); // G
        pixels[idx + 2] = Math.round(180 + t * 40); // B
        pixels[idx + 3] = 255; // A
      } else {
        pixels[idx + 3] = 0; // transparent
      }
    }
  }

  // Token Watcher monogram, generated locally with no font dependency.
  drawTW(pixels, size);

  return pixels;
}

function isInRoundedRect(x, y, w, h, r) {
  if (x < 0 || x >= w || y < 0 || y >= h) return false;
  if ((x >= r && x < w - r) || (y >= r && y < h - r)) return true;
  const cornerX = x < r ? r : w - r - 1;
  const cornerY = y < r ? r : h - r - 1;
  return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= r ** 2;
}

function drawTW(pixels, size) {
  const strokes = [
    [0.18, 0.3, 0.42, 0.3],
    [0.3, 0.3, 0.3, 0.7],
    [0.48, 0.3, 0.54, 0.7],
    [0.54, 0.7, 0.65, 0.48],
    [0.65, 0.48, 0.76, 0.7],
    [0.76, 0.7, 0.82, 0.3],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (
        strokes.some(
          ([a, b, c, d]) =>
            distToLineSegment(x, y, a * size, b * size, c * size, d * size) <= size * 0.027,
        )
      ) {
        const i = (y * size + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
    }
  }
}

function distToLineSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nearX = x1 + t * dx;
  const nearY = y1 + t * dy;
  return Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
}

// =============================================================================
// Main
// =============================================================================

function main() {
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(iconsDir, { recursive: true });

  console.log("Generating app icon...");
  const pixels = createIconPixels(SIZE);
  const png = createPng(SIZE, SIZE, pixels);

  writeFileSync(iconPath, png);
  console.log(`  Created ${iconPath} (${SIZE}x${SIZE} PNG)`);

  // Generate smaller sizes for Linux
  const linuxSizes = [16, 22, 24, 32, 48, 64, 96, 128, 256];
  for (const s of linuxSizes) {
    // Simple nearest-neighbor downscale
    const smallPixels = Buffer.alloc(s * s * 4);
    const scale = SIZE / s;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const srcX = Math.floor(x * scale);
        const srcY = Math.floor(y * scale);
        const srcIdx = (srcY * SIZE + srcX) * 4;
        const dstIdx = (y * s + x) * 4;
        smallPixels[dstIdx] = pixels[srcIdx];
        smallPixels[dstIdx + 1] = pixels[srcIdx + 1];
        smallPixels[dstIdx + 2] = pixels[srcIdx + 2];
        smallPixels[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }
    const smallPng = createPng(s, s, smallPixels);
    const smallPath = join(iconsDir, `${s}x${s}.png`);
    writeFileSync(smallPath, smallPng);
    console.log(`  Created ${smallPath} (${s}x${s})`);
  }

  console.log("Icon generation complete!");
}

main();
