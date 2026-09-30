import { expect, test } from "bun:test";
import {
  parseAppFlags,
  parseTagAppChoice,
  tagAppChoices,
  tagAppPrompt,
} from "../../packages/cli/src/tag-apps";

test("offers every enabled app first, then each app alone", () => {
  const choices = tagAppChoices(["imessage", "whatsapp"]);
  expect(choices).toEqual([
    { apps: ["imessage", "whatsapp"], label: "iMessage and WhatsApp" },
    { apps: ["imessage"], label: "iMessage only" },
    { apps: ["whatsapp"], label: "WhatsApp only" },
  ]);
  expect(tagAppPrompt("@s4", choices)).toContain("1. iMessage and WhatsApp (default)");
  expect(parseTagAppChoice("", choices)).toEqual(["imessage", "whatsapp"]);
  expect(parseTagAppChoice("3", choices)).toEqual(["whatsapp"]);
  expect(parseTagAppChoice("iMessage", choices)).toEqual(["imessage"]);
  expect(parseTagAppChoice("9", choices)).toBeNull();
  expect(tagAppChoices(["imessage"])).toEqual([{ apps: ["imessage"], label: "iMessage" }]);
});

test("parses repeated --app flags and rejects unknown apps", () => {
  expect(parseAppFlags(["add", "@s4", "--app", "WhatsApp", "--app", "whatsapp", "--json"])).toEqual({
    apps: ["whatsapp"],
    json: true,
    positional: ["add", "@s4"],
  });
  expect(() => parseAppFlags(["add", "@s4", "--app", "telegram"])).toThrow("--app must be");
});
