// Turns the official export files from ChatGPT, Claude and Gemini into one
// plain shape. No DOM access, so it runs in Node for tests.
//
// A conversation looks like:
// { id, source, title, createdAt, updatedAt, messages: [{ role, text, at }] }
// role is "user" or "assistant"; times are ISO strings or "".

export const SOURCES = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  chatkeep: "Chatkeep backup",
};

function isoFromSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

function isoFromString(value) {
  if (typeof value !== "string" || !value) return "";
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

function tidy(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function detectFormat(data) {
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data)) {
    return data.app === "chatkeep" && Array.isArray(data.conversations) ? "chatkeep" : null;
  }
  if (data.length === 0) return null;
  const first = data.find((entry) => entry && typeof entry === "object");
  if (!first) return null;
  if (first.mapping && typeof first.mapping === "object") return "chatgpt";
  if (Array.isArray(first.chat_messages)) return "claude";
  if (typeof first.header === "string" && typeof first.title === "string" && /gemini/i.test(first.header)) {
    return "gemini";
  }
  if (typeof first.title === "string" && /^Prompted\b/.test(first.title)) return "gemini";
  return null;
}

export function parseExport(data) {
  const format = detectFormat(data);
  switch (format) {
    case "chatgpt":
      return { format, conversations: parseChatGpt(data) };
    case "claude":
      return { format, conversations: parseClaude(data) };
    case "gemini":
      return { format, conversations: parseGemini(data) };
    case "chatkeep":
      return { format, conversations: normalizeConversations(data.conversations) };
    default:
      return { format: null, conversations: [] };
  }
}

// ---- ChatGPT: conversations.json ----
// Each conversation is a tree of nodes in `mapping`; `current_node` is the
// leaf of the branch the person last looked at. Walking parents from there
// gives the conversation as they saw it.

function chatGptText(message) {
  const content = message && message.content;
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.result === "string") return content.result;
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (part.content_type === "image_asset_pointer") return "[image]";
          if (part.content_type === "audio_transcription" && typeof part.text === "string") return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function chatGptBranch(conv) {
  const mapping = conv.mapping || {};
  let nodeId = conv.current_node;
  if (!nodeId || !mapping[nodeId]) {
    // Fall back to the deepest leaf.
    const ids = Object.keys(mapping);
    nodeId = ids.find((id) => !mapping[id].children || mapping[id].children.length === 0) || ids[ids.length - 1];
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  return chain.reverse();
}

export function parseChatGpt(data) {
  const out = [];
  for (const conv of data) {
    if (!conv || typeof conv !== "object" || !conv.mapping) continue;
    const messages = [];
    for (const node of chatGptBranch(conv)) {
      const message = node.message;
      if (!message || !message.author) continue;
      const role = message.author.role;
      if (role !== "user" && role !== "assistant") continue;
      if (message.metadata && message.metadata.is_visually_hidden_from_conversation) continue;
      const text = tidy(chatGptText(message));
      if (!text) continue;
      messages.push({ role, text, at: isoFromSeconds(message.create_time) });
    }
    if (messages.length === 0) continue;
    const sourceId = conv.conversation_id || conv.id || messages[0].at || String(out.length);
    out.push({
      id: `chatgpt:${sourceId}`,
      source: "chatgpt",
      title: tidy(conv.title) || firstLine(messages),
      createdAt: isoFromSeconds(conv.create_time) || messages[0].at,
      updatedAt: isoFromSeconds(conv.update_time) || messages[messages.length - 1].at,
      messages,
    });
  }
  return out;
}

// ---- Claude: conversations.json ----

function claudeText(message) {
  if (Array.isArray(message.content) && message.content.length > 0) {
    const parts = message.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "tool_use") return "";
        if (block.type === "tool_result") return "";
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n\n");
  }
  return typeof message.text === "string" ? message.text : "";
}

export function parseClaude(data) {
  const out = [];
  for (const conv of data) {
    if (!conv || typeof conv !== "object" || !Array.isArray(conv.chat_messages)) continue;
    const messages = [];
    for (const message of conv.chat_messages) {
      if (!message || typeof message !== "object") continue;
      const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      const text = tidy(claudeText(message));
      if (!text) continue;
      messages.push({ role, text, at: isoFromString(message.created_at) });
    }
    if (messages.length === 0) continue;
    const sourceId = conv.uuid || messages[0].at || String(out.length);
    out.push({
      id: `claude:${sourceId}`,
      source: "claude",
      title: tidy(conv.name) || firstLine(messages),
      createdAt: isoFromString(conv.created_at) || messages[0].at,
      updatedAt: isoFromString(conv.updated_at) || messages[messages.length - 1].at,
      messages,
    });
  }
  return out;
}

// ---- Gemini: Google Takeout "My Activity / Gemini Apps / MyActivity.json" ----
// Takeout has no conversation ids, only one record per prompt with the reply
// as HTML. Prompts less than 30 minutes apart are grouped as one chat.

const GEMINI_GAP_MS = 30 * 60 * 1000;

export function htmlToText(html) {
  let text = String(html ?? "");
  text = text.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\/\s*(p|div|li|h[1-6]|tr|pre|blockquote)\s*>/gi, "\n");
  text = text.replace(/<\s*li[^>]*>/gi, "- ");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
  return text.replace(/\n{3,}/g, "\n\n");
}

function geminiPrompt(entry) {
  const title = typeof entry.title === "string" ? entry.title : "";
  return title.replace(/^Prompted\s*/i, "");
}

function geminiReply(entry) {
  if (Array.isArray(entry.safeHtmlItem)) {
    return entry.safeHtmlItem
      .map((item) => (item && typeof item.html === "string" ? htmlToText(item.html) : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  if (Array.isArray(entry.subtitles)) {
    return entry.subtitles.map((s) => (s && typeof s.name === "string" ? s.name : "")).filter(Boolean).join("\n");
  }
  return "";
}

export function parseGemini(data) {
  const entries = data
    .filter((entry) => entry && typeof entry === "object" && typeof entry.title === "string" && /^Prompted\b/i.test(entry.title))
    .map((entry) => ({ prompt: tidy(geminiPrompt(entry)), reply: tidy(geminiReply(entry)), at: isoFromString(entry.time) }))
    .filter((entry) => entry.prompt || entry.reply)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const out = [];
  let current = null;
  let lastTime = null;
  for (const entry of entries) {
    const t = entry.at ? new Date(entry.at).getTime() : null;
    const startNew = !current || t === null || lastTime === null || t - lastTime > GEMINI_GAP_MS;
    if (startNew) {
      current = {
        id: `gemini:${entry.at || "undated-" + out.length}`,
        source: "gemini",
        title: entry.prompt.split("\n")[0].slice(0, 80) || "Gemini chat",
        createdAt: entry.at,
        updatedAt: entry.at,
        messages: [],
      };
      out.push(current);
    }
    if (entry.prompt) current.messages.push({ role: "user", text: entry.prompt, at: entry.at });
    if (entry.reply) current.messages.push({ role: "assistant", text: entry.reply, at: entry.at });
    current.updatedAt = entry.at || current.updatedAt;
    lastTime = t;
  }
  return out;
}

// ---- Shared ----

function firstLine(messages) {
  const first = messages.find((m) => m.role === "user") || messages[0];
  return first.text.split("\n")[0].slice(0, 80) || "Untitled chat";
}

export function normalizeConversations(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const conv of list) {
    if (!conv || typeof conv !== "object" || typeof conv.id !== "string" || !Array.isArray(conv.messages)) continue;
    const messages = conv.messages
      .filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, text: tidy(m.text), at: isoFromString(m.at) }))
      .filter((m) => m.text);
    if (messages.length === 0) continue;
    out.push({
      id: conv.id,
      source: SOURCES[conv.source] ? conv.source : "chatkeep",
      title: tidy(conv.title) || firstLine(messages),
      createdAt: isoFromString(conv.createdAt) || messages[0].at,
      updatedAt: isoFromString(conv.updatedAt) || messages[messages.length - 1].at,
      messages,
    });
  }
  return out;
}

// Which file inside an export zip holds the chats.
export function pickZipEntry(names) {
  const lower = names.map((n) => n.toLowerCase());
  const candidates = [
    (n) => /(^|\/)conversations\.json$/.test(n),
    (n) => /gemini[^/]*\/myactivity\.json$/.test(n),
    (n) => /(^|\/)myactivity\.json$/.test(n),
  ];
  for (const test of candidates) {
    const index = lower.findIndex(test);
    if (index !== -1) return names[index];
  }
  return null;
}

export function describeImport(format, added, skipped) {
  const label = SOURCES[format] || "file";
  const parts = [];
  if (added > 0) parts.push(`Added ${added} ${added === 1 ? "chat" : "chats"} from ${label}.`);
  if (skipped > 0) parts.push(`${skipped} ${skipped === 1 ? "was" : "were"} already here.`);
  if (parts.length === 0) parts.push(`No chats found in that ${label} file.`);
  return parts.join(" ");
}
