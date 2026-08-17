import { sendJson } from "./http-utils.js";
import { checkJarvisVoiceStatus } from "./jarvis-voice-status.js";

// GET /api/jarvis/voice-status - read-only, no token: same trust level as
// /api/jarvis/ready and /api/jarvis/system. Unlike those, this route does
// make one short-timeout network call (see jarvis-voice-status.js for why
// that is deliberately kept out of checkJarvisReadiness()).
export function createJarvisVoiceStatusHandler({ checkVoiceStatusFn = checkJarvisVoiceStatus } = {}) {
  return async function handleJarvisVoiceStatus(request, response) {
    const status = await checkVoiceStatusFn();
    sendJson(response, 200, { schemaVersion: "1.0", whisper: status.whisper, piper: status.piper });
  };
}

export const handleJarvisVoiceStatus = createJarvisVoiceStatusHandler();
