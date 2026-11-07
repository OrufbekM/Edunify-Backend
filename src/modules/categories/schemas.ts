import { z } from 'zod';

import { trimmedString } from '../../lib/validation.js';

export const categoryBody = z.strictObject({ name: trimmedString(1, 60) });
