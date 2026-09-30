/** The vision model the visual checks ask: Claude through the library's /ai entry, or none without a token. */
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { Reviewer } from "@dcl-regenesislabs/wearable-validator";
import { createPiReviewer, setupTokenCredentials } from "@dcl-regenesislabs/wearable-validator/ai";

export const NO_MODEL_REASON = "The model was not called: the job has no ANTHROPIC_OAUTH_SETUP_TOKEN.";

/** No model: every visual check that asks one is answered "not called", so its row errors with this reason. */
export function noModelReviewer(): Reviewer {
  return {
    async review(request) {
      return { ok: false, reason: NO_MODEL_REASON, metadata: { provider: "none", model: "none", promptVersion: request.prompt.version, promptDigest: request.promptDigest } };
    }
  };
}

export async function createReviewer(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<Reviewer> {
  // the only credential is the year-long `claude setup-token`: held in memory, nothing to refresh or persist
  const token = await components.config.getString("ANTHROPIC_OAUTH_SETUP_TOKEN");
  if (token) return createPiReviewer({ credentials: setupTokenCredentials(token) });
  components.logs.getLogger("reviewer").warn("no ANTHROPIC_OAUTH_SETUP_TOKEN: items render, but the visual checks that ask the model are not answered");
  return noModelReviewer();
}
