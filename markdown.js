// Markdown export and small text helpers shared by the app and the tests.

import { SOURCES } from "./importers.js";

export function formatDate(iso, options = {}) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  });
}

export function conversationToMarkdown(conv) {
  const lines = [`# ${conv.title}`, ""];
  const meta = [`Source: ${SOURCES[conv.source] || conv.source}`];
  if (conv.createdAt) meta.push(`Started: ${conv.createdAt}`);
  if (conv.updatedAt && conv.updatedAt !== conv.createdAt) meta.push(`Last message: ${conv.updatedAt}`);
  lines.push(meta.join("  \n"), "");
  for (const message of conv.messages) {
    const who = message.role === "user" ? "You" : SOURCES[conv.source] || "Assistant";
    const when = message.at ? ` (${message.at})` : "";
    lines.push(`## ${who}${when}`, "", message.text, "");
  }
  return lines.join("\n");
}

export function fileSafeName(name, fallback = "chat") {
  const safe = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return safe || fallback;
}

export function conversationFileName(conv, taken = new Set()) {
  const day = conv.createdAt ? conv.createdAt.slice(0, 10) : "undated";
  let base = `${conv.source}/${day}-${fileSafeName(conv.title)}`;
  let name = `${base}.md`;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}.md`;
  taken.add(name);
  return name;
}

// Case-insensitive search over title and messages. Returns null when the
// conversation does not match, else a short snippet around the first hit.
export function searchConversation(conv, query) {
  const q = query.trim().toLowerCase();
  if (!q) return { snippet: "" };
  if (conv.title.toLowerCase().includes(q)) return { snippet: "" };
  for (const message of conv.messages) {
    const index = message.text.toLowerCase().indexOf(q);
    if (index !== -1) {
      const start = Math.max(0, index - 60);
      const end = Math.min(message.text.length, index + q.length + 80);
      const snippet = (start > 0 ? "…" : "") + message.text.slice(start, end).replace(/\s+/g, " ") + (end < message.text.length ? "…" : "");
      return { snippet };
    }
  }
  return null;
}

export function previewText(conv) {
  const first = conv.messages.find((m) => m.role === "user") || conv.messages[0];
  return first ? first.text.replace(/\s+/g, " ").slice(0, 140) : "";
}
