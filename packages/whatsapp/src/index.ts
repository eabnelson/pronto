import { createModule } from "./internal/module.js";
import type { CreateProntoWhatsappOptions, ProntoWhatsapp } from "./types.js";

export * from "./types.js";

export function createProntoWhatsapp(options: CreateProntoWhatsappOptions): ProntoWhatsapp {
  return createModule(options);
}
