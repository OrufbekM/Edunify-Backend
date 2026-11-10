import { randomBytes } from 'node:crypto';

import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';

import { fitForModel, type ImageLimits } from './images.js';
import type { Page } from './prompt.js';

const MIMES: Page['mime'][] = ['image/png', 'image/jpeg', 'image/webp'];

function solid(width: number, height: number): Sharp {
  return sharp({ create: { width, height, channels: 3, background: '#3366cc' } });
}

// Random pixels don't compress, so a small image is large in bytes.
function noise(width: number, height: number): Sharp {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } });
}

function encode(image: Sharp, mime: Page['mime']): Promise<Buffer> {
  switch (mime) {
    case 'image/png':
      return image.png().toBuffer();
    case 'image/jpeg':
      return image.jpeg().toBuffer();
    case 'image/webp':
      return image.webp().toBuffer();
  }
}

async function dimensions(data: Buffer): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(data).metadata();
  return { width, height };
}

const roomy: ImageLimits = { maxLongEdge: 100, maxBase64Length: 1_000_000 };

describe('fitForModel', () => {
  it.each(MIMES)('sends a %s within the limits as it is', async (mime) => {
    const page = { mime, data: await encode(solid(100, 30), mime) };

    expect(await fitForModel(page, roomy)).toBe(page);
  });

  it.each(MIMES)('scales a %s down to the long-edge limit, keeping its type and shape', async (mime) => {
    const fitted = await fitForModel({ mime, data: await encode(solid(300, 150), mime) }, roomy);

    expect(fitted.mime).toBe(mime);
    expect(await dimensions(fitted.data)).toEqual({ width: 100, height: 50 });
  });

  it('measures a portrait page by its height', async () => {
    const fitted = await fitForModel({ mime: 'image/png', data: await encode(solid(150, 300), 'image/png') }, roomy);

    expect(await dimensions(fitted.data)).toEqual({ width: 50, height: 100 });
  });

  it('turns a photo upright by its EXIF orientation before re-encoding it', async () => {
    // Stored landscape, tagged "rotate 90° clockwise to display", as phone cameras do.
    const data = await solid(300, 150).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const fitted = await fitForModel({ mime: 'image/jpeg', data }, roomy);

    expect(await dimensions(fitted.data)).toEqual({ width: 50, height: 100 });
    expect((await sharp(fitted.data).metadata()).orientation).toBeUndefined();
  });

  it('uses the 2576 px limit by default', async () => {
    const fitted = await fitForModel({ mime: 'image/jpeg', data: await encode(solid(3000, 100), 'image/jpeg') });

    expect(await dimensions(fitted.data)).toEqual({ width: 2576, height: 86 });
  });

  it('re-encodes a page that is small enough in pixels but too large in bytes', async () => {
    const data = await encode(noise(64, 64), 'image/png');

    const fitted = await fitForModel({ mime: 'image/png', data }, { maxLongEdge: 100, maxBase64Length: 2_000 });

    // Still too large as PNG at the same size, so it goes out as JPEG.
    expect(fitted.mime).toBe('image/jpeg');
    expect(await dimensions(fitted.data)).toEqual({ width: 64, height: 64 });
  });

  it('paints transparent areas white, not black, when it falls back to JPEG', async () => {
    // Left half transparent, right half opaque noise: a drawing on a transparent canvas.
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i += 1) {
      if (i % 64 >= 32) {
        randomBytes(3).copy(pixels, i * 4);
        pixels[i * 4 + 3] = 255;
      }
    }
    const data = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();

    const fitted = await fitForModel({ mime: 'image/png', data }, { maxLongEdge: 100, maxBase64Length: 2_000 });
    const corner = await sharp(fitted.data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();

    expect(fitted.mime).toBe('image/jpeg');
    expect([...corner].every((channel) => channel >= 250)).toBe(true);
  });

  it('rejects bytes that are not a readable image', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

    await expect(fitForModel({ mime: 'image/png', data })).rejects.toThrow();
  });
});
