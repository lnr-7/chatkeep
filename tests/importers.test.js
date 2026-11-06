import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describeImport, detectFormat, htmlToText, normalizeConversations, parseExport, pickZipEntry } from "../importers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

test("detectFormat tells the four formats apart", () => {
  assert.equal(detectFormat(fixture("chatgpt-conversations.json")), "chatgpt");
  assert.equal(detectFormat(fixture("claude-conversations.json")), "claude");
  assert.equal(detectFormat(fixture("gemini-myactivity.json")), "gemini");
  assert.equal(detectFormat({ app: "chatkeep", conversations: [] }), "chatkeep");
  assert.equal(detectFormat([]), null);
  assert.equal(detectFormat({ hello: 1 }), null);
  assert.equal(detectFormat("nope"), null);
  assert.equal(detectFormat([{ random: true }]), null);
});

test("ChatGPT: follows the current branch, skips hidden and tool messages", () => {
  const { format, conversations } = parseExport(fixture("chatgpt-conversations.json"));
  assert.equal(format, "chatgpt");
  assert.equal(conversations.length, 2);

  const [goa, haiku] = conversations;
  assert.equal(goa.id, "chatgpt:conv-aaa");
  assert.equal(goa.title, "Plan a Goa trip");
  assert.equal(goa.createdAt, "2026-10-29T08:00:00.500Z");
  assert.equal(goa.updatedAt, "2026-10-29T09:00:00.000Z");
  assert.deepEqual(
    goa.messages.map((m) => [m.role, m.text]),
    [
      ["user", "Help me plan 3 days in Goa"],
      ["assistant", "Sure. Day 1: beaches.\nDay 2: old town."],
      ["user", "[image]\nWhat about this beach?"],
    ],
  );
  assert.ok(!JSON.stringify(goa).includes("regenerated"));

  assert.equal(haiku.id, "chatgpt:conv-bbb");
  assert.equal(haiku.title, "Write a haiku about rain");
  assert.equal(haiku.messages.length, 1);
});

test("Claude: joins text blocks, drops tool blocks and blank messages", () => {
  const { format, conversations } = parseExport(fixture("claude-conversations.json"));
  assert.equal(format, "claude");
  assert.equal(conversations.length, 2);

  const [resume, tea] = conversations;
  assert.equal(resume.id, "claude:c-111");
  assert.equal(resume.title, "Fix my resume");
  assert.equal(resume.createdAt, "2026-10-30T10:00:00.000Z");
  assert.deepEqual(
    resume.messages.map((m) => [m.role, m.text]),
    [
      ["user", "Can you tighten this summary?"],
      ["assistant", "Here is a tighter version:\n\nEngineer with 5 years in payments."],
    ],
  );
  assert.equal(tea.title, "Just a quick question about tea");
});

test("Gemini: strips HTML and groups prompts close in time", () => {
  const { format, conversations } = parseExport(fixture("gemini-myactivity.json"));
  assert.equal(format, "gemini");
  assert.equal(conversations.length, 2);

  const [goa, tea] = conversations;
  assert.equal(goa.title, "What is the capital of Goa?");
  assert.equal(goa.messages.length, 4);
  assert.equal(goa.messages[1].text, "The capital of Goa is Panaji.\n- Also spelled Panjim");
  assert.equal(goa.messages[3].text, "Vasco da Gama & Margao are the largest.\nPanaji is smaller.");
  assert.equal(goa.createdAt, "2026-10-25T09:05:00.000Z");
  assert.equal(goa.updatedAt, "2026-10-25T09:07:00.000Z");

  assert.equal(tea.title, "Write a limerick about tea");
  assert.equal(tea.messages.length, 2);
});

test("htmlToText handles entities and block tags", () => {
  assert.equal(htmlToText("<p>a &lt; b</p><p>c &amp; d</p>"), "a < b\nc & d\n");
  assert.equal(htmlToText("x<br/>y"), "x\ny");
});

test("backup files round-trip through normalizeConversations", () => {
  const { conversations } = parseExport(fixture("claude-conversations.json"));
  const again = parseExport({ app: "chatkeep", conversations });
  assert.equal(again.format, "chatkeep");
  assert.deepEqual(again.conversations, conversations);
});

test("normalizeConversations rejects junk", () => {
  assert.deepEqual(normalizeConversations("x"), []);
  assert.deepEqual(normalizeConversations([{ id: 1, messages: [] }]), []);
  assert.deepEqual(normalizeConversations([{ id: "a", messages: [{ role: "system", text: "x" }] }]), []);
  const [conv] = normalizeConversations([{ id: "a", source: "nope", messages: [{ role: "user", text: " hi " }] }]);
  assert.equal(conv.source, "chatkeep");
  assert.equal(conv.title, "hi");
});

test("pickZipEntry finds the chat file inside an export zip", () => {
  assert.equal(pickZipEntry(["user.json", "conversations.json", "chat.html"]), "conversations.json");
  assert.equal(pickZipEntry(["users.json", "projects.json", "conversations.json"]), "conversations.json");
  assert.equal(
    pickZipEntry(["Takeout/My Activity/Gemini Apps/MyActivity.json", "Takeout/archive_browser.html"]),
    "Takeout/My Activity/Gemini Apps/MyActivity.json",
  );
  assert.equal(pickZipEntry(["photo.jpg"]), null);
});

test("describeImport wording", () => {
  assert.equal(describeImport("chatgpt", 3, 0), "Added 3 chats from ChatGPT.");
  assert.equal(describeImport("claude", 1, 1), "Added 1 chat from Claude. 1 was already here.");
  assert.equal(describeImport("gemini", 0, 2), "2 were already here.");
  assert.equal(describeImport("chatgpt", 0, 0), "No chats found in that ChatGPT file.");
});
