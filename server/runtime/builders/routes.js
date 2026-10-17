// HTTP surface for the coding agents' brains (mounted at /api/builders, behind
// the same local session gate as every other /api route).
//
//   GET /api/builders/brains
//     -> { claude: {mode, model}, codex: {mode, model}, cursor: {mode, model},
//          onLimit: "ask" | "auto", perRunBudgetUsd: number | null,
//          modes: { <agentId>: { plan|openrouter|local: { available, reason?, note? },
//                                models?: [{ id, label, note? }] } } }
//        mode is "plan" | "openrouter" | "local" (see builders/brains.js).
//        `modes` says what each agent offers and why not (Cursor: plan only);
//        a screen can disable a segment and show `reason`.
//
//   PUT /api/builders/brains   { confirm: true, claude?, codex?, cursor?, onLimit?, perRunBudgetUsd? }
//     Anything left out keeps its value; an agent that is present is replaced as
//     a whole ({ mode, model }). Answers like GET. Errors: { error, message }
//       400 invalid_brain / invalid_model_id / invalid_model / invalid_on_limit /
//           invalid_budget / budget_required
//       400 brain_not_supported (Cursor with openrouter or local)
//
// The OpenRouter key is not part of any of this (see secrets/routes.js).
import express from "express";
import { CURSOR_MODELS, CURSOR_ONLY_PLAN } from "./brain-launch.js";
import { loadBrains, saveBrains } from "./brains.js";
import { builderErrorResponse } from "./resolve.js";

function modesInfo() {
  return {
    claude: {
      plan: { available: true },
      openrouter: {
        available: true,
        note: "Pay per use from your OpenRouter credit. Claude models work best; other models are experimental."
      },
      local: { available: true, note: "Experimental: local models use tools less reliably." }
    },
    codex: {
      plan: { available: true },
      openrouter: {
        available: true,
        note: "Pay per use from your OpenRouter credit. OpenAI models work best; other models are experimental."
      },
      local: { available: true, note: "Experimental: local models use tools less reliably." }
    },
    cursor: {
      plan: { available: true },
      openrouter: { available: false, reason: CURSOR_ONLY_PLAN },
      local: { available: false, reason: CURSOR_ONLY_PLAN },
      models: CURSOR_MODELS.map((id) =>
        id === "auto"
          ? { id, label: "Auto", note: "Auto is billed at the price of the model it picks." }
          : { id, label: "Composer 2.5 (Cursor's own model)" }
      )
    }
  };
}

export function createBuildersRouter() {
  // caseSensitive: "/brains" and "/BRAINS" are different addresses.
  const router = express.Router({ caseSensitive: true });

  function fail(error, res, next) {
    const mapped = builderErrorResponse(error);
    if (mapped) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(error);
  }

  router.get("/brains", async (_req, res, next) => {
    try {
      res.json({ ...(await loadBrains()), modes: modesInfo() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/brains", async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({ ok: false, error: "confirm must be true" });
        return;
      }
      const saved = await saveBrains(req.body);
      res.json({ ...saved, modes: modesInfo() });
    } catch (error) {
      fail(error, res, next);
    }
  });

  return router;
}
