import { runtimeSelection, type ProntoConfig } from "../config";
import { RuntimeChain } from "./chain";
import { createRuntimeAdapter } from "./factory";

export function runtimeChainForTag(config: ProntoConfig, tag?: string): RuntimeChain {
  const selection = runtimeSelection(config, tag);
  if (selection.primaryRuntimePath === undefined ||
      (selection.fallbackRuntime !== undefined && selection.fallbackRuntimePath === undefined)) {
    throw new Error("Agent executable path is missing; run pronto setup or choose agents for this tag again");
  }
  return new RuntimeChain(
    createRuntimeAdapter(selection.primaryRuntime, selection.primaryRuntimePath),
    selection.fallbackRuntime === undefined ? undefined : createRuntimeAdapter(selection.fallbackRuntime, selection.fallbackRuntimePath!),
  );
}
