import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { crc32, listEntries, readEntryText, writeZip } from "../zip.js";
import { conversationFileName, conversationToMarkdown, fileSafeName, searchConversation } from "../markdown.js";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("a written zip can be read back", async () => {
  const zip = writeZip([
    { name: "a/hello.md", text: "# Hello\n\nnamaste ✈" },
    { name: "b.txt", text: "" },
  ]);
  const entries = listEntries(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.size]), [
    ["a/hello.md", 0, new TextEncoder().encode("# Hello\n\nnamaste ✈").length],
    ["b.txt", 0, 0],
  ]);
  assert.equal(await readEntryText(zip, entries[0]), "# Hello\n\nnamaste ✈");
  assert.equal(await readEntryText(zip, entries[1]), "");
});

test("a deflated zip made by another tool can be read", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "chatkeep-"));
  const big = "conversations ".repeat(5000);
  writeFileSync(path.join(dir, "conversations.json"), big);
  try {
    execFileSync(
      "python3",
      ["-I", "-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write(sys.argv[2],'Takeout/conversations.json'); z.close()", path.join(dir, "export.zip"), path.join(dir, "conversations.json")],
      { stdio: "ignore" },
    );
  } catch {
    t.skip("python3 not available to build a deflated zip");
    return;
  }
  const bytes = readFileSync(path.join(dir, "export.zip"));
  const entries = listEntries(bytes);
  assert.equal(entries[0].name, "Takeout/conversations.json");
  assert.equal(entries[0].method, 8);
  assert.equal(await readEntryText(bytes, entries[0]), big);
});

test("listEntries rejects things that are not zips", () => {
  assert.throws(() => listEntries(new TextEncoder().encode("{\"json\": true}")), /Not a zip/);
});

test("conversationToMarkdown writes a readable file", () => {
  const md = conversationToMarkdown({
    id: "claude:1",
    source: "claude",
    title: "Fix my resume",
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:20:00.000Z",
    messages: [
      { role: "user", text: "Tighten this", at: "2026-10-30T10:00:00.000Z" },
      { role: "assistant", text: "Here you go.\n\nDone.", at: "" },
    ],
  });
  assert.equal(
    md,
    [
      "# Fix my resume",
      "",
      "Source: Claude  \nStarted: 2026-10-30T10:00:00.000Z  \nLast message: 2026-10-30T10:20:00.000Z",
      "",
      "## You (2026-10-30T10:00:00.000Z)",
      "",
      "Tighten this",
      "",
      "## Claude",
      "",
      "Here you go.\n\nDone.",
      "",
    ].join("\n"),
  );
});

test("file names are safe and unique", () => {
  assert.equal(fileSafeName("Plan a Goa trip!?"), "plan-a-goa-trip");
  assert.equal(fileSafeName("???"), "chat");
  const taken = new Set();
  const conv = { source: "chatgpt", title: "Same", createdAt: "2026-10-29T08:00:00Z" };
  assert.equal(conversationFileName(conv, taken), "chatgpt/2026-10-29-same.md");
  assert.equal(conversationFileName(conv, taken), "chatgpt/2026-10-29-same-2.md");
  assert.equal(conversationFileName({ source: "gemini", title: "", createdAt: "" }, taken), "gemini/undated-chat.md");
});

test("searchConversation matches titles and message text with a snippet", () => {
  const conv = {
    title: "Trip",
    messages: [{ role: "user", text: "A long message about packing socks and a charger for the trip." }],
  };
  assert.deepEqual(searchConversation(conv, "trip"), { snippet: "" });
  assert.equal(searchConversation(conv, "CHARGER").snippet, "A long message about packing socks and a charger for the trip.");
  assert.equal(searchConversation(conv, "banana"), null);
  assert.deepEqual(searchConversation(conv, "  "), { snippet: "" });
});
