/**
 * 规划35 多模态方案 C：只读**文件头**拿宽高，不解码像素、不看内容。
 *
 * 支持 PNG / JPEG / WebP 三种（与上传白名单一致）。任何越界或畸形输入一律返回 null，
 * 由调用方如实说「读不到尺寸」，而不是猜一个。
 */
export interface ImageSize { readonly width: number; readonly height: number }

function png(bytes: Buffer): ImageSize | null {
  // 89 50 4E 47 0D 0A 1A 0A + IHDR length(4) + "IHDR" + width(4) + height(4)
  if (bytes.length < 24) return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpeg(bytes: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15（排除 DHT/JPG/DAC）
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function webp(bytes: Buffer): ImageSize | null {
  // RIFF <size> WEBP <chunk fourcc> <chunk size> ...
  if (bytes.length < 30) return null;
  const fourcc = bytes.toString("ascii", 12, 16);
  if (fourcc === "VP8X") {
    // canvas width/height are 24-bit little-endian, stored minus one.
    const width = bytes.readUIntLE(24, 3) + 1, height = bytes.readUIntLE(27, 3) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8L") {
    // 0x2F signature then 14-bit width-1 / 14-bit height-1, little-endian bit packed.
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1, height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8 ") {
    // 3-byte frame tag, 3-byte start code (9D 01 2A), then 14-bit width/height (LE).
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = bytes.readUInt16LE(26) & 0x3fff, height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

export function readImageSize(bytes: Buffer, mimeType: string): ImageSize | null {
  try {
    if (mimeType === "image/png") return png(bytes);
    if (mimeType === "image/jpeg") return jpeg(bytes);
    if (mimeType === "image/webp") return webp(bytes);
    return null;
  } catch { return null; }
}
