/**
 * Content sniffing for materialized Messages attachments.
 *
 * Attachments are copied with `convert_attachments: false`, so the bytes are
 * whatever the sending device produced. iPhones send HEIC photos, QuickTime or
 * MPEG-4 videos, and CAF or M4A audio; those must be recognised alongside the
 * original PNG, JPEG, GIF, PDF, ZIP and UTF-8 text signatures. Anything the
 * sniffer cannot identify, or whose bytes contradict the advertised type, is
 * still refused.
 */

/** ISO base media file format brands (the `ftyp` box) mapped to a detected type. */
const ISO_BMFF_BRANDS: ReadonlyMap<string, string> = new Map([
  ["heic", "image/heic"],
  ["heix", "image/heic"],
  ["heim", "image/heic"],
  ["heis", "image/heic"],
  ["hevc", "image/heic-sequence"],
  ["hevx", "image/heic-sequence"],
  ["hevm", "image/heic-sequence"],
  ["hevs", "image/heic-sequence"],
  ["mif1", "image/heif"],
  ["mif2", "image/heif"],
  ["heif", "image/heif"],
  ["msf1", "image/heif-sequence"],
  ["avif", "image/avif"],
  ["avis", "image/avif"],
  ["qt  ", "video/quicktime"],
  ["M4V ", "video/x-m4v"],
  ["M4VH", "video/x-m4v"],
  ["M4VP", "video/x-m4v"],
  ["M4A ", "audio/mp4"],
  ["M4B ", "audio/mp4"],
  ["M4P ", "audio/mp4"],
  ["isom", "video/mp4"],
  ["iso2", "video/mp4"],
  ["iso3", "video/mp4"],
  ["iso4", "video/mp4"],
  ["iso5", "video/mp4"],
  ["iso6", "video/mp4"],
  ["mp41", "video/mp4"],
  ["mp42", "video/mp4"],
  ["avc1", "video/mp4"],
  ["3gp4", "video/3gpp"],
  ["3gp5", "video/3gpp"],
  ["3gp6", "video/3gpp"],
  ["3gp7", "video/3gpp"],
  ["3ge6", "video/3gpp"],
  ["3ge7", "video/3gpp"],
  ["3gg6", "video/3gpp"],
  ["3g2a", "video/3gpp2"],
  ["3g2b", "video/3gpp2"],
  ["3g2c", "video/3gpp2"],
]);

const HEIF_FAMILY = [
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
] as const;
const VIDEO_FAMILY = ["video/quicktime", "video/mp4", "video/x-m4v"] as const;
const MP4_AUDIO_FAMILY = ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"] as const;
const THIRD_GENERATION_FAMILY = ["video/3gpp", "video/3gpp2", "audio/3gpp", "audio/3gpp2"] as const;

/**
 * Advertised types accepted for a detected container type, beyond an exact
 * match. Containers share byte signatures across related declared types (an
 * iPhone photo may be declared `image/heic` while its brand says HEIF; a
 * generic `isom`/`mp42` file may hold video or audio only), so each detected
 * type accepts its own family and nothing else.
 */
const COMPATIBLE_DECLARATIONS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...HEIF_FAMILY.map((type) => [type, HEIF_FAMILY] as const),
  ["video/quicktime", VIDEO_FAMILY],
  ["video/x-m4v", VIDEO_FAMILY],
  ["video/mp4", [...VIDEO_FAMILY, ...MP4_AUDIO_FAMILY]],
  ["audio/mp4", MP4_AUDIO_FAMILY],
  ["video/3gpp", THIRD_GENERATION_FAMILY],
  ["video/3gpp2", THIRD_GENERATION_FAMILY],
  ["audio/x-caf", ["audio/x-caf", "audio/caf"]],
]);

function isoBmffMime(data: Buffer): string | undefined {
  // size(4) "ftyp"(4) major_brand(4) minor_version(4) compatible_brands(4 * n)
  if (data.length < 16 || data.toString("latin1", 4, 8) !== "ftyp") return undefined;
  const boxSize = data.readUInt32BE(0);
  if (boxSize < 16 || boxSize % 4 !== 0) return undefined;
  const major = ISO_BMFF_BRANDS.get(data.toString("latin1", 8, 12));
  if (major !== undefined) return major;
  const end = Math.min(boxSize, data.length);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const compatible = ISO_BMFF_BRANDS.get(data.toString("latin1", offset, offset + 4));
    if (compatible !== undefined) return compatible;
  }
  return undefined;
}

function cafMime(data: Buffer): string | undefined {
  // "caff", file version 1, file flags 0.
  return data.length >= 8 && data.toString("latin1", 0, 4) === "caff" &&
      data.readUInt16BE(4) === 1 && data.readUInt16BE(6) === 0
    ? "audio/x-caf"
    : undefined;
}

export function detectedMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip";
  }
  const media = isoBmffMime(data) ?? cafMime(data);
  if (media !== undefined) return media;
  try {
    if (data.length > 0 && !data.includes(0)) {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return "text/plain";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Returns the effective MIME type for an attachment whose leading bytes are
 * `data`, or `undefined` when the bytes are unrecognised or contradict the
 * advertised type.
 *
 * An exact match, an `application/octet-stream` declaration, or UTF-8 text
 * declared as any `text/*` type yields the detected type. A declaration from
 * the detected container's family (for example `image/heic` over a `mif1`
 * brand, or `audio/x-m4a` over a generic `mp42` brand) keeps the more specific
 * advertised type.
 */
export function resolveAttachmentMime(advertised: string, data: Buffer): string | undefined {
  const detected = detectedMime(data);
  if (detected === undefined) return undefined;
  if (advertised === "application/octet-stream" || advertised === detected) return detected;
  if (detected === "text/plain" && advertised.startsWith("text/")) return detected;
  return COMPATIBLE_DECLARATIONS.get(detected)?.includes(advertised) === true ? advertised : undefined;
}
