import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { MaterializedWhatsappAttachment } from "../types.js";
import { describeFailure, runCommand } from "./process.js";

/** wacli refuses media over 100 MiB; Pronto consumers usually ask for much less. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MESSAGE_ID = /^[0-9A-Za-z._-]{1,128}$/;

const MIME_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

export function mimeTypeFor(name: string, declared: string | null): string {
  const bare = declared?.split(";")[0]?.trim();
  if (bare !== undefined && /^[a-z]+\/[0-9a-z.+-]+$/i.test(bare)) return bare.toLowerCase();
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Downloads one message's media with `wacli --read-only media download`, which takes no
 * store lock and so works while `sync --follow` runs. The file lands in a fresh 0700 directory.
 */
export async function downloadAttachment(input: {
  readonly attachmentsDir: string;
  readonly chatJid: string;
  readonly declaredMimeType: string | null;
  readonly maxBytes: number;
  readonly messageId: string;
  readonly storeDir: string;
  readonly timeoutMs: number;
  readonly wacliPath: string;
}): Promise<MaterializedWhatsappAttachment> {
  if (!MESSAGE_ID.test(input.messageId)) throw new Error("WhatsApp message id is invalid");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error("Attachment budget must be a positive integer");
  }
  await mkdir(input.attachmentsDir, { mode: 0o700, recursive: true });
  await chmod(input.attachmentsDir, 0o700);
  const directory = await mkdtemp(join(input.attachmentsDir, "attachment-"));
  const dispose = async () => await rm(directory, { force: true, recursive: true });
  try {
    const result = await runCommand(
      input.wacliPath,
      [
        "--store", input.storeDir, "--read-only", "--json",
        `--timeout=${Math.max(1, Math.floor(input.timeoutMs / 1_000) - 2)}s`,
        "media", "download", `--chat=${input.chatJid}`, `--id=${input.messageId}`, `--output=${directory}`,
      ],
      { timeoutMs: input.timeoutMs },
    );
    if (result.code !== 0) {
      throw new Error(`WhatsApp attachment is unavailable: ${describeFailure(result)}`);
    }
    const entries = await readdir(directory);
    if (entries.length !== 1) throw new Error("WhatsApp attachment is unavailable");
    const name = basename(entries[0]!);
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("WhatsApp attachment is unavailable");
    if (stat.size > input.maxBytes || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("WhatsApp attachment exceeds the size budget");
    }
    await chmod(path, 0o600);
    return {
      dispose,
      mimeType: mimeTypeFor(name, input.declaredMimeType),
      name,
      path,
      sha256: await sha256File(path),
      sizeBytes: stat.size,
    };
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}
