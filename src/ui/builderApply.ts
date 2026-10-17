// How the model picker (ModelPicker.tsx) "applies" a model for the coding agents:
//   builderApplier  save it as the agent's OpenRouter brain (PUT /api/builders/brains)
// The picker shows the returned lines as its result.
import { getOpenRouterKeyStatus, saveBuilderBrains } from "../buildersApi";
import type { BuilderId } from "../buildersApi";
import { explain } from "./builderShared";
import type { ApplyFn, ModelApplyResult } from "./modelPickerShared";

export const NO_KEY_WARNING =
  "No OpenRouter key is saved yet, so runs on OpenRouter won't start until you connect OpenRouter on the card and tick “Remember for coding agents”.";

export function builderApplier(agentId: BuilderId, label: string): ApplyFn {
  return async ({ subject }) => {
    const model = subject.model?.id || "";
    let result: ModelApplyResult;
    try {
      await saveBuilderBrains({ [agentId]: { mode: "openrouter", model } });
      const warnings: string[] = [];
      try {
        if (!(await getOpenRouterKeyStatus()).stored) warnings.push(NO_KEY_WARNING);
      } catch {
        // the key row on the card says the same thing; not worth failing the save
      }
      result = {
        targetId: agentId,
        ok: true,
        changed: true,
        headline: `${label} will now use ${subject.title} on OpenRouter`,
        detail: "It is paid per use from your OpenRouter credit. Your own sign-in is not touched.",
        warnings
      };
    } catch (error) {
      result = {
        targetId: agentId,
        ok: false,
        headline: `Couldn't switch ${label} to ${subject.title}.`,
        detail: explain(error)
      };
    }
    return [result];
  };
}
