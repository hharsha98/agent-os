// HTTP surface for "Remember my OpenRouter key for coding agents" (mounted at
// /api/secrets, behind the same local session gate as every other /api route).
// The key itself is never returned by any route here: only whether one is saved,
// where, and its last 4 characters.
//
//   GET    /api/secrets/openrouter
//     -> { stored: boolean, backend: "keychain" | "file", last4: string | null }
//        backend is where the key is (or, when nothing is saved, where it would go).
//
//   POST   /api/secrets/openrouter   { confirm: true, flowId }  or  { confirm: true, apiKey }
//     Saves the key. flowId is a CONNECTED "Connect OpenRouter" sign-in (its key is
//     only looked at, not used up, so the Hermes/OpenClaw setup can still take
//     it); apiKey is a pasted key (checked with OpenRouter first). Answers like GET.
//       400 confirm must be true / invalid_key / invalid_flow_id / openrouter_rejected_key
//       400 not_available_here (a hosted or demo copy never keeps a key)
//       409 connection_not_ready (the sign-in isn't connected) / key_unavailable
//       500 keystore_failed
//
//   DELETE /api/secrets/openrouter
//     Forgets the saved key. Answers like GET.
import express from "express";
import { authRequired } from "../auth.js";
import { isDemoPublic } from "../demo-public.js";
import { FLOW_ID_PATTERN, getStatus as getFlowStatus, peekKey } from "../setup/openrouter-oauth.js";
import { verifyOpenRouterKey } from "../setup/brain.js";
import { forgetOpenRouterKey, isValidOpenRouterKey, openRouterKeyStatus, storeOpenRouterKey } from "./keystore.js";

function refuse(res, status, error, message) {
  res.status(status).json({ ok: false, error, message });
}

export function createSecretsRouter() {
  // caseSensitive: "/openrouter" and "/OPENROUTER" are different addresses.
  const router = express.Router({ caseSensitive: true });

  router.get("/openrouter", async (_req, res, next) => {
    try {
      res.json(await openRouterKeyStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post("/openrouter", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      // A hosted or demo copy must never keep a person's key.
      if (isDemoPublic() || authRequired()) {
        refuse(res, 400, "not_available_here", "Remembering a key only works in the desktop app on your own computer.");
        return;
      }

      let key = "";
      const pasted = req.body?.apiKey;
      if (typeof pasted === "string" && pasted.trim()) {
        key = pasted.trim();
        if (!isValidOpenRouterKey(key)) {
          refuse(res, 400, "invalid_key", "That doesn't look like an OpenRouter key. It starts with sk-or-.");
          return;
        }
        // Only a definite "no" from OpenRouter stops the save; a network hiccup
        // says nothing about the key.
        const verified = await verifyOpenRouterKey(key);
        if (!verified.ok && verified.rejected) {
          refuse(res, 400, "openrouter_rejected_key", "OpenRouter rejected that key.");
          return;
        }
      } else {
        const flowId = req.body?.flowId;
        if (typeof flowId !== "string" || !FLOW_ID_PATTERN.test(flowId)) {
          refuse(res, 400, "invalid_flow_id", "That OpenRouter connection isn't valid. Connect OpenRouter again.");
          return;
        }
        if (getFlowStatus(flowId)?.status !== "connected") {
          refuse(res, 409, "connection_not_ready", "Connect OpenRouter first, then try again.");
          return;
        }
        // peekKey: looked at, not used up (the setup job may still need it).
        key = peekKey(flowId) || "";
        if (!key) {
          refuse(res, 409, "key_unavailable", "That OpenRouter connection is no longer available. Connect again.");
          return;
        }
      }

      try {
        res.json(await storeOpenRouterKey(key));
      } catch (error) {
        if (error?.code === "invalid_key") {
          refuse(res, 400, "invalid_key", error.message);
          return;
        }
        refuse(res, 500, "keystore_failed", "Couldn't save the key on this computer.");
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/openrouter", async (_req, res, next) => {
    try {
      res.json(await forgetOpenRouterKey());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
