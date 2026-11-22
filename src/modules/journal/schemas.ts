import { z } from 'zod';

import { uuidSchema } from '../../lib/validation.js';

export const classParams = z.strictObject({ classId: uuidSchema });
