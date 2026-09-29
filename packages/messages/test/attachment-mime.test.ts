import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectedMime, resolveAttachmentMime } from "../src/internal/attachment-mime";

// Synthetic media generated on macOS: a 16x16 solid-colour image through
// `sips -s format heic`, a 0.2 s solid-colour H.264 clip through ffmpeg and
// `avconvert` (QuickTime and MPEG-4), and a 0.1 s sine tone through
// `afconvert` (CAF and M4A).
const fixture = async (name: string) =>
  await readFile(join(import.meta.dir, "fixtures", "attachments", name));

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function ftyp(major: string, ...compatible: string[]): Buffer {
  const box = Buffer.alloc(16 + 4 * compatible.length);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compatible.forEach((brand, index) => box.write(brand, 16 + 4 * index, "latin1"));
  return Buffer.concat([box, Buffer.from([0, 0, 0, 8]), Buffer.from("free", "latin1")]);
}

test("real iPhone-style media fixtures are detected by container signature", async () => {
  expect(detectedMime(await fixture("photo.heic"))).toBe("image/heic");
  expect(detectedMime(await fixture("clip.mov"))).toBe("video/quicktime");
  expect(detectedMime(await fixture("clip.mp4"))).toBe("video/mp4");
  expect(detectedMime(await fixture("voice.m4a"))).toBe("audio/mp4");
  expect(detectedMime(await fixture("voice.caf"))).toBe("audio/x-caf");
});

test("declared Messages types resolve for real media fixtures", async () => {
  const heic = await fixture("photo.heic");
  expect(resolveAttachmentMime("image/heic", heic)).toBe("image/heic");
  expect(resolveAttachmentMime("image/heif", heic)).toBe("image/heif");
  expect(resolveAttachmentMime("application/octet-stream", heic)).toBe("image/heic");

  const mov = await fixture("clip.mov");
  expect(resolveAttachmentMime("video/quicktime", mov)).toBe("video/quicktime");
  expect(resolveAttachmentMime("video/mp4", mov)).toBe("video/mp4");

  const mp4 = await fixture("clip.mp4");
  expect(resolveAttachmentMime("video/mp4", mp4)).toBe("video/mp4");
  expect(resolveAttachmentMime("video/quicktime", mp4)).toBe("video/quicktime");
  expect(resolveAttachmentMime("video/x-m4v", mp4)).toBe("video/x-m4v");

  const m4a = await fixture("voice.m4a");
  expect(resolveAttachmentMime("audio/x-m4a", m4a)).toBe("audio/x-m4a");
  expect(resolveAttachmentMime("audio/mp4", m4a)).toBe("audio/mp4");

  const caf = await fixture("voice.caf");
  expect(resolveAttachmentMime("audio/x-caf", caf)).toBe("audio/x-caf");
  expect(resolveAttachmentMime("audio/caf", caf)).toBe("audio/caf");
});

test("brands are read from the major brand, then compatible brands", () => {
  expect(detectedMime(ftyp("mif1", "heic"))).toBe("image/heif");
  expect(resolveAttachmentMime("image/heic", ftyp("mif1", "heic"))).toBe("image/heic");
  expect(detectedMime(ftyp("hevc", "mif1"))).toBe("image/heic-sequence");
  expect(detectedMime(ftyp("avif", "mif1"))).toBe("image/avif");
  expect(detectedMime(ftyp("M4V ", "isom"))).toBe("video/x-m4v");
  expect(detectedMime(ftyp("3gp5", "isom"))).toBe("video/3gpp");
  expect(detectedMime(ftyp("XYZW", "zzzz", "mp42"))).toBe("video/mp4");
  expect(resolveAttachmentMime("audio/mp4", ftyp("isom", "mp42"))).toBe("audio/mp4");
});

test("genuine mismatches are still refused", async () => {
  const heic = await fixture("photo.heic");
  const mov = await fixture("clip.mov");
  const m4a = await fixture("voice.m4a");
  const caf = await fixture("voice.caf");
  const html = Buffer.from("<!doctype html><html><body>hi</body></html>");

  expect(resolveAttachmentMime("image/jpeg", html)).toBeUndefined();
  expect(resolveAttachmentMime("image/heic", html)).toBeUndefined();
  expect(resolveAttachmentMime("video/quicktime", html)).toBeUndefined();
  expect(resolveAttachmentMime("image/jpeg", heic)).toBeUndefined();
  expect(resolveAttachmentMime("video/quicktime", heic)).toBeUndefined();
  expect(resolveAttachmentMime("image/heic", mov)).toBeUndefined();
  expect(resolveAttachmentMime("audio/mp4", mov)).toBeUndefined();
  expect(resolveAttachmentMime("video/mp4", m4a)).toBeUndefined();
  expect(resolveAttachmentMime("audio/mp4", caf)).toBeUndefined();
  expect(resolveAttachmentMime("image/avif", heic)).toBeUndefined();
  expect(resolveAttachmentMime("image/heic", ftyp("avif"))).toBeUndefined();
  expect(resolveAttachmentMime("image/heic", jpeg)).toBeUndefined();
  expect(resolveAttachmentMime("image/png", mov)).toBeUndefined();
});

test("malformed or unknown containers are not detected", async () => {
  expect(detectedMime(ftyp("crx ", "isoz"))).toBeUndefined();
  expect(detectedMime(ftyp("heic").subarray(0, 12))).toBeUndefined();
  const badSize = ftyp("heic");
  badSize.writeUInt32BE(10, 0);
  expect(detectedMime(badSize)).toBeUndefined();
  // Compatible brands beyond the ftyp box are not consulted.
  const outside = Buffer.concat([ftyp("XYZW").subarray(0, 16), Buffer.from("heic", "latin1")]);
  expect(detectedMime(outside)).toBeUndefined();
  const caf = Buffer.from(await fixture("voice.caf"));
  caf.writeUInt16BE(2, 4);
  expect(detectedMime(caf)).toBeUndefined();
  expect(resolveAttachmentMime("application/octet-stream", ftyp("crx "))).toBeUndefined();
});

test("existing signatures keep their behaviour", () => {
  expect(resolveAttachmentMime("image/png", png)).toBe("image/png");
  expect(resolveAttachmentMime("application/octet-stream", png)).toBe("image/png");
  expect(resolveAttachmentMime("image/jpeg", jpeg)).toBe("image/jpeg");
  expect(resolveAttachmentMime("image/gif", Buffer.from("GIF89a...", "latin1"))).toBe("image/gif");
  expect(resolveAttachmentMime("application/pdf", Buffer.from("%PDF-1.7"))).toBe("application/pdf");
  expect(resolveAttachmentMime("application/zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(
    "application/zip",
  );
  expect(resolveAttachmentMime("text/csv", Buffer.from("a,b\n1,2\n"))).toBe("text/plain");
  expect(resolveAttachmentMime("image/png", Buffer.from("plain text"))).toBeUndefined();
  expect(resolveAttachmentMime("image/png", jpeg)).toBeUndefined();
  expect(resolveAttachmentMime("text/plain", Buffer.from([0xc3, 0x28]))).toBeUndefined();
  expect(resolveAttachmentMime("application/octet-stream", Buffer.alloc(0))).toBeUndefined();
});
