import { z } from 'zod';

// Unknown parameters are rejected as on every route. exp and sig themselves are left to the
// signature check, which answers 403 for anything wrong with them (missing, repeated,
// malformed, expired or forged).
export const signedFileQuery = z.strictObject({
  exp: z.unknown().optional(),
  sig: z.unknown().optional(),
});

// Not checked as a uuid here: the signature comes first (see readSignedFile).
export const fileParams = z.strictObject({ id: z.string() });
