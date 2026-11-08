import { Router } from 'express';

import { generalLimiter } from '../../middleware/rateLimit.js';
import { fileParams, signedFileQuery } from './schemas.js';
import * as files from './service.js';

// RFC 8187: percent-encode everything that isn't an attr-char. encodeURIComponent leaves
// ' ( ) * alone, and those aren't attr-chars.
function encodeFileName(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const filesRouter = Router();

// No requireAuth: the signed URL is the credential, so <img>, <iframe> and fetch work
// (contract 7). With no user, the general limiter counts per IP.
filesRouter.get('/:id', generalLimiter, async (req, res) => {
  const { id } = fileParams.parse(req.params);
  const { exp, sig } = signedFileQuery.parse(req.query);
  const { file, data } = await files.readSignedFile(id, exp, sig);

  res.set({
    // Markdown goes out as plain text, so a browser never renders it as anything else.
    'Content-Type': file.mime === 'text/markdown' ? 'text/plain; charset=utf-8' : file.mime,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeFileName(file.originalName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
  // Sets Content-Length; for HEAD it sends the headers alone.
  res.send(data);
});
