import sharp, { type Sharp } from 'sharp';

import type { Page } from './prompt.js';

// Claude 4.7 and later models read an image at up to 2576 px on its long edge and scale a
// larger one down first, so a page sent at that size loses nothing. The API rejects an image
// over 8000 px on a side or over 10 MB once base64-encoded, and a 10 MB upload (contract 7)
// is about 13 MB in base64.
export const MAX_LONG_EDGE = 2576;
// The 10 MB limit, read as decimal megabytes to stay on the safe side of it.
export const MAX_BASE64_LENGTH = 10_000_000;

export interface ImageLimits {
  maxLongEdge: number;
  maxBase64Length: number;
}

const LIMITS: ImageLimits = { maxLongEdge: MAX_LONG_EDGE, maxBase64Length: MAX_BASE64_LENGTH };
const QUALITY = 85;

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function encodeAs(image: Sharp, mime: Page['mime']): Sharp {
  switch (mime) {
    case 'image/png':
      return image.png();
    case 'image/jpeg':
      return image.jpeg({ quality: QUALITY });
    case 'image/webp':
      return image.webp({ quality: QUALITY });
  }
}

// A page the model can take as it is goes out unchanged. Any other is scaled down to fit and
// re-encoded in its own type, or as JPEG when that is still too large, as a detailed photo
// saved as PNG can be. Throws for bytes that aren't a readable image, which counts the
// submission as failed. The stored file is never changed: the teacher still sees the original.
export async function fitForModel(page: Page, limits: ImageLimits = LIMITS): Promise<Page> {
  const { width, height } = await sharp(page.data).metadata();

  if (
    Math.max(width, height) <= limits.maxLongEdge &&
    base64Length(page.data.length) <= limits.maxBase64Length
  ) {
    return page;
  }

  // Re-encoding drops the EXIF orientation, so it is applied to the pixels first; otherwise
  // a phone photo would reach the model on its side.
  const scaled = () =>
    sharp(page.data).autoOrient().resize({
      width: limits.maxLongEdge,
      height: limits.maxLongEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });

  const sameType = await encodeAs(scaled(), page.mime).toBuffer();

  if (base64Length(sameType.length) <= limits.maxBase64Length) {
    return { mime: page.mime, data: sameType };
  }

  // JPEG has no transparency and would fill it with black; drawings are made on white.
  const jpeg = await scaled().flatten({ background: '#ffffff' }).jpeg({ quality: QUALITY }).toBuffer();

  return { mime: 'image/jpeg', data: jpeg };
}
