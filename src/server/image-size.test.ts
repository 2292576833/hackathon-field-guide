import assert from "node:assert/strict";
import test from "node:test";
import { readImageSize } from "./image-size.ts";
import { suggestPlacement } from "./page-assets.ts";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(0xffd8, 0);
  bytes.writeUInt16BE(0xffc0, 2);
  bytes.writeUInt16BE(11, 4);
  bytes[6] = 8; bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes;
}
function webpLossless(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii"); bytes.write("WEBP", 8, "ascii"); bytes.write("VP8L", 12, "ascii");
  bytes[20] = 0x2f;
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  bytes.writeUInt32LE(packed >>> 0, 21);
  return bytes;
}

test("PNG 从 IHDR 读宽高", () => {
  assert.deepEqual(readImageSize(png(1200, 630), "image/png"), { width: 1200, height: 630 });
});

test("JPEG 从 SOF0 读宽高", () => {
  assert.deepEqual(readImageSize(jpeg(800, 600), "image/jpeg"), { width: 800, height: 600 });
});

test("WebP（VP8L）读宽高", () => {
  assert.deepEqual(readImageSize(webpLossless(300, 400), "image/webp"), { width: 300, height: 400 });
});

test("畸形或不支持的输入返回 null，不抛错也不猜", () => {
  assert.equal(readImageSize(Buffer.alloc(4), "image/png"), null);
  assert.equal(readImageSize(Buffer.alloc(40), "image/jpeg"), null);
  assert.equal(readImageSize(Buffer.alloc(40), "image/webp"), null);
  assert.equal(readImageSize(png(10, 10), "image/gif"), null);
});

test("放置建议只按宽高比：横图横幅、方图赞助墙、竖图人物墙", () => {
  assert.equal(suggestPlacement({ width: 1600, height: 900 })?.aspect, "16:9");
  assert.deepEqual(suggestPlacement({ width: 1600, height: 900 })?.blocks, ["bannerImage"]);
  assert.equal(suggestPlacement({ width: 800, height: 600 })?.aspect, "4:3");
  assert.equal(suggestPlacement({ width: 600, height: 600 })?.aspect, "1:1");
  assert.deepEqual(suggestPlacement({ width: 600, height: 600 })?.blocks, ["sponsorWall"]);
  assert.equal(suggestPlacement({ width: 450, height: 600 })?.aspect, "3:4");
  assert.deepEqual(suggestPlacement({ width: 450, height: 600 })?.blocks, ["peopleWall"]);
  assert.equal(suggestPlacement(null), null, "读不到尺寸就不给建议");
  assert.match(suggestPlacement({ width: 100, height: 100 })!.note, /不读取图片内容/);
});
