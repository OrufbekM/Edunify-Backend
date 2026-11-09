import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config/env.js';

export type ModelRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type ModelResponse = Anthropic.Beta.BetaMessage;

let client: Anthropic | null = null;

// The one call to the Claude API, kept on an object so tests can replace it. The SDK
// retries 408, 409, 429, 5xx and connection errors twice by default.
export const model = {
  async send(request: ModelRequest): Promise<ModelResponse> {
    client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return client.beta.messages.create(request);
  },
};
