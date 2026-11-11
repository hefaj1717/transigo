// Browser only. Photo from the phone camera → JPEG for upload (owner 2026-11-11: longer side ~1600 px, ~80 %).
// The orientation from EXIF is applied by the browser (createImageBitmap / <img> follow it by default), so the
// result is always upright. A too large result (rare) is encoded again at a lower quality.
import { PHOTO_JPEG_QUALITY, PHOTO_MAX_BYTES, scaledSize } from "@/lib/carriers/execution";

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Some formats (older Safari, HEIC on Android) — fall back to <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

const toJpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

export class PhotoUnreadableError extends Error {}

export async function compressPhoto(file: Blob): Promise<Blob> {
  let img: Awaited<ReturnType<typeof decode>>;
  try {
    img = await decode(file);
  } catch {
    throw new PhotoUnreadableError("photo cannot be decoded");
  }
  try {
    const size = scaledSize(img.width, img.height);
    if (!size.width) throw new PhotoUnreadableError("empty photo");
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoUnreadableError("no canvas");
    ctx.fillStyle = "#fff"; // transparent PNG screenshots → white, not black
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img.source, 0, 0, size.width, size.height);
    for (const q of [PHOTO_JPEG_QUALITY, 0.6, 0.45]) {
      const blob = await toJpeg(canvas, q);
      if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
    }
    throw new PhotoUnreadableError("photo too large");
  } finally {
    img.close();
  }
}
