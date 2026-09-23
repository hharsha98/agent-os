import { isDemoPublic } from "./demo-public.js";

function flag(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Operator explicitly turned the live chat lane off. */
export function liveChatForcedOff(env = process.env) {
  const value = flag(env.AGENT_OS_LIVE_CHAT);
  return value === "0" || value === "false" || value === "no" || value === "off";
}

/**
 * Live chat calls OmniRoute and the OpenClaw gateway.
 * It does not unlock arbitrary shell. DEMO_PUBLIC still wins.
 */
export function isLiveChatEnabled(env = process.env) {
  if (isDemoPublic(env)) return false;
  if (liveChatForcedOff(env)) return false;
  const value = flag(env.AGENT_OS_LIVE_CHAT);
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  return env.HERMES_AGENT_OS_ENABLE_EXEC === "1";
}
