import sharp from "sharp";
import type { AvatarContent } from "./model.ts";
import { invalid } from "./validation.ts";

/** Uses the already-installed Next.js raster runtime; decoding is local and never fetches an external URL. */
export async function verifyDecodedAvatar(avatar: AvatarContent): Promise<AvatarContent> {
  try {
    const image = sharp(Buffer.from(avatar.bytes), { failOn: "error", limitInputPixels: 2048 * 2048, animated: false });
    const metadata = await image.metadata(), expected = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[avatar.mimeType];
    if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > 2048 || metadata.height > 2048 || (metadata.pages ?? 1) > 1) invalid("头像须为2048×2048以内的完整静态图片。");
    const decoded = await image.raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== metadata.width || decoded.info.height !== metadata.height || !decoded.data.byteLength) invalid("图片无法完整读取，请换一张图片。");
    return avatar;
  } catch { invalid("图片无法完整读取，请上传有效的PNG、JPEG或静态WebP图片。"); }
}
