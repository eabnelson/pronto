import { renderUnicodeCompact } from "uqr";
import { createProntoWhatsapp, type ProntoWhatsapp } from "pronto-whatsapp";
import type { ProntoPaths } from "../macos/paths";

export const WHATSAPP_DISCLOSURE = `WhatsApp support uses wacli, which links this Mac as a WhatsApp device through
the unofficial WhatsApp Web protocol. It is not affiliated with WhatsApp or Meta.
Automated use of a linked device may violate WhatsApp's terms and can lead to your
account being restricted. Replies are sent from your own WhatsApp account, and anyone
in a chat where you have sent a message can trigger a reply with your tag.`;

/** Pronto's standalone WhatsApp module, sharing the reply-scope lifetime used for iMessage. */
export function standaloneWhatsapp(input: {
  readonly chatKeySalt: string;
  readonly paths: Pick<ProntoPaths, "whatsappStatePath" | "whatsappStoreDirectory">;
  readonly scopeTtlMs: number;
  readonly wacliPath: string;
}): ProntoWhatsapp {
  return createProntoWhatsapp({
    presence: true,
    referenceKey: input.chatKeySalt,
    scopeLimits: { ttlMs: input.scopeTtlMs },
    statePath: input.paths.whatsappStatePath,
    storeDir: input.paths.whatsappStoreDirectory,
    wacliPath: input.wacliPath,
  });
}

/** Links this Mac in the terminal: shows each rotating QR code (or a pairing code) until linked. */
export async function linkWhatsappInTerminal(
  whatsapp: ProntoWhatsapp,
  options: { readonly phone?: string; readonly write?: (text: string) => void } = {},
): Promise<string> {
  const write = options.write ?? ((text: string) => console.log(text));
  for await (const step of whatsapp.link(options.phone === undefined ? {} : { phone: options.phone })) {
    if (step.type === "qr") {
      write(`\n${renderUnicodeCompact(step.code, { border: 2 })}`);
      write("Scan with WhatsApp: Settings → Linked devices → Link a device. The code refreshes automatically.");
    } else if (step.type === "pairing_code") {
      write(`\nIn WhatsApp choose Link with phone number instead, then enter: ${step.code}`);
    } else if (step.type === "linked") {
      return step.linkedJid;
    } else {
      throw new Error(`WhatsApp linking failed: ${step.reason}`);
    }
  }
  throw new Error("WhatsApp linking ended before the device was linked");
}
