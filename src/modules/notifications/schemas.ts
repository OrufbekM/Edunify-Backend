import { z } from 'zod';

// POST /notifications/:id/read takes no body; an unknown field is still rejected.
export const noBody = z.strictObject({}).optional();
