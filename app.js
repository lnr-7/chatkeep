import { SOURCES, describeImport, parseExport, pickZipEntry } from "./importers.js";
import { listEntries, readEntryText, writeZip } from "./zip.js";
import { conversationFileName, conversationToMarkdown, fileSafeName, formatDate, previewText, searchConversation } from "./markdown.js";
import * as db from "./db.js";

const PAGE = 200;

let conversations = [];
const ui = { query: "", shown: PAGE, busy: false };

const app = document.getElementById("app");
const listPane = document.getElementById("list-pane");
const readPane = document.getElementById("read-pane");
const fileInput = document.getElementById("file-input");
const dropVeil = document.getElementById("drop-veil");
const confirmDialog = document.getElementById("confirm-dialog");
const toastEl = document.getElementById("toast");

// ---- DOM helpers ----

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Text with the search query wrapped in <mark>, built from text nodes only.
function highlighted(text, query) {
  const q = query.trim();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let from = 0;
  let index = lower.indexOf(needle, from);
  while (index !== -1) {
    if (index > from) parts.push(text.slice(from, index));
    parts.push(el("mark", {}, text.slice(index, index + needle.length)));
    from = index + needle.length;
    index = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function downloadBytes(filename, bytes, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer = null;
function toast(text, ms = 4000) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

let confirmAction = null;
function confirm(title, text, okLabel, run) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  document.getElementById("confirm-ok").textContent = okLabel;
  confirmAction = run;
  confirmDialog.showModal();
}
document.getElementById("confirm-ok").addEventListener("click", () => {
  const run = confirmAction;
  confirmAction = null;
  confirmDialog.close();
  if (run) run();
});
confirmDialog.querySelector("[data-close]").addEventListener("click", () => confirmDialog.close());
confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) confirmDialog.close();
});

// ---- Routing ----

function route() {
  const match = (location.hash || "").match(/^#\/c\/(.+)$/);
  return match ? { id: decodeURIComponent(match[1]) } : { id: null };
}

window.addEventListener("hashchange", () => {
  render();
  if (route().id) readPane.scrollTop = 0;
});

// ---- Rendering ----

function sorted() {
  return [...conversations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function render() {
  const { id } = route();
  const current = id ? conversations.find((c) => c.id === id) : null;
  if (id && !current) {
    location.replace("#/");
    return;
  }
  app.classList.toggle("is-reading", Boolean(current));
  app.classList.toggle("is-empty", conversations.length === 0);

  if (conversations.length === 0) {
    app.classList.remove("is-reading");
    listPane.replaceChildren(renderWelcome());
    readPane.replaceChildren();
    document.title = "Chatkeep";
    return;
  }

  const focused = document.activeElement;
  const keepSearch = focused && focused.classList.contains("search");
  const selection = keepSearch ? [focused.selectionStart, focused.selectionEnd] : null;

  listPane.replaceChildren(...renderList(current));
  readPane.replaceChildren(current ? renderRead(current) : renderPlaceholder());
  document.title = current ? `${current.title} – Chatkeep` : "Chatkeep";

  if (keepSearch) {
    const again = listPane.querySelector(".search");
    again.focus({ preventScroll: true });
    if (selection) again.setSelectionRange(selection[0], selection[1]);
  }
}

function renderWelcome() {
  const zone = el(
    "div",
    {
      class: "dropzone",
      ondragover: (event) => {
        event.preventDefault();
        zone.classList.add("is-over");
      },
      ondragleave: () => zone.classList.remove("is-over"),
      ondrop: (event) => {
        event.preventDefault();
        zone.classList.remove("is-over");
        importFiles(event.dataTransfer.files);
      },
    },
    el("strong", {}, "Drop your export file here"),
    el("span", {}, "The .zip or .json you got from ChatGPT, Claude or Gemini"),
    el("button", { type: "button", class: "btn btn-main", onclick: () => fileInput.click() }, "Choose a file"),
  );

  return el(
    "div",
    { class: "welcome" },
    el("h1", {}, "Keep your own copy of your AI chats."),
    el(
      "p",
      {},
      "Every chat service lets you download your history, but the file is unreadable. Give it to Chatkeep and you get a searchable archive that you own.",
    ),
    zone,
    el(
      "p",
      { class: "privacy" },
      "Files are read inside this page and saved in this browser only. The page is set up so it cannot send anything to any server.",
    ),
    el(
      "details",
      { class: "howto" },
      el("summary", {}, "How to get your export file"),
      el(
        "div",
        { class: "howto-grid" },
        howto("ChatGPT", ["Settings, then Data controls", "Export data, then confirm", "Open the email link and download the .zip"]),
        howto("Claude", ["Settings, then Privacy", "Export data", "Download the .zip from the email"]),
        howto("Gemini", [
          "Go to takeout.google.com and deselect all",
          "Select only My Activity, then choose Gemini Apps and the JSON format",
          "Download the .zip when it is ready",
        ]),
      ),
      el(
        "p",
        { class: "howto-note" },
        "Menus move around. If the path above has changed, look for 'export' in the service's settings. Chatkeep reads conversations.json (ChatGPT, Claude) and MyActivity.json (Gemini).",
      ),
    ),
  );
}

function howto(name, steps) {
  return el(
    "div",
    { class: "howto-card" },
    el("h3", {}, name),
    el(
      "ol",
      {},
      steps.map((step) => el("li", {}, step)),
    ),
  );
}

function renderList(current) {
  const all = sorted();
  const query = ui.query;
  const matches = [];
  for (const conv of all) {
    const hit = searchConversation(conv, query);
    if (hit) matches.push({ conv, snippet: hit.snippet });
  }
  const shown = matches.slice(0, ui.shown);

  const search = el("input", {
    type: "search",
    class: "search",
    placeholder: "Search every message",
    "aria-label": "Search every message",
    value: query,
    oninput: (event) => {
      ui.query = event.target.value;
      ui.shown = PAGE;
      render();
    },
  });

  const head = el(
    "div",
    { class: "list-head" },
    el(
      "div",
      { class: "list-title" },
      el("h1", {}, "Chats"),
      el("span", { class: "count" }, query ? `${matches.length} of ${all.length}` : `${all.length}`),
    ),
    search,
    query ? el("p", { class: "search-note" }, matches.length === 0 ? "No chat mentions that." : "Matching chats, newest first.") : null,
  );

  const list = el(
    "ul",
    { class: "chat-list" },
    shown.map(({ conv, snippet }) =>
      el(
        "li",
        {},
        el(
          "a",
          {
            class: "chat-link" + (current && current.id === conv.id ? " is-current" : ""),
            href: `#/c/${encodeURIComponent(conv.id)}`,
            "aria-current": current && current.id === conv.id ? "page" : undefined,
          },
          el("div", { class: "chat-link-title" }, highlighted(conv.title, query)),
          el(
            "div",
            { class: "chat-link-meta" },
            el("span", { class: "source" }, SOURCES[conv.source] || conv.source),
            el("span", {}, formatDate(conv.updatedAt, { hour: undefined, minute: undefined })),
            el("span", {}, `${conv.messages.length} ${conv.messages.length === 1 ? "message" : "messages"}`),
          ),
          el("div", { class: "chat-link-preview" }, highlighted(snippet || previewText(conv), query)),
        ),
      ),
    ),
  );

  const nodes = [head, list];
  if (matches.length > shown.length) {
    nodes.push(
      el(
        "div",
        { class: "list-more" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-line",
            onclick: () => {
              ui.shown += PAGE;
              render();
            },
          },
          `Show ${Math.min(PAGE, matches.length - shown.length)} more`,
        ),
      ),
    );
  }
  nodes.push(
    el(
      "div",
      { class: "list-foot" },
      el("button", { type: "button", class: "btn btn-quiet", onclick: () => fileInput.click() }, "Add another export file"),
      el("button", { type: "button", class: "btn btn-quiet", onclick: exportAllMarkdown }, "Save all as Markdown (.zip)"),
      el("button", { type: "button", class: "btn btn-quiet", onclick: exportBackup }, "Save a backup (.json)"),
      el(
        "button",
        {
          type: "button",
          class: "btn btn-quiet btn-danger-text",
          onclick: () =>
            confirm(
              "Delete every chat?",
              `All ${all.length} chats will be removed from this browser. Your export files are not affected.`,
              "Delete everything",
              async () => {
                await db.clear();
                conversations = [];
                ui.query = "";
                location.hash = "#/";
                render();
                toast("Deleted everything.");
              },
            ),
        },
        "Delete everything",
      ),
    ),
  );
  return nodes;
}

function renderPlaceholder() {
  return el("p", { class: "read-placeholder" }, "Pick a chat on the left to read it.");
}

function renderRead(conv) {
  const who = SOURCES[conv.source] || "Assistant";
  return el(
    "article",
    { class: "read" },
    el("a", { class: "btn btn-quiet read-back", href: "#/" }, "All chats"),
    el(
      "header",
      { class: "read-head" },
      el("h1", {}, highlighted(conv.title, ui.query)),
      el(
        "div",
        { class: "read-meta" },
        el("span", { class: "source" }, who),
        conv.createdAt ? el("span", {}, `Started ${formatDate(conv.createdAt)}`) : null,
        conv.updatedAt && conv.updatedAt !== conv.createdAt ? el("span", {}, `Last message ${formatDate(conv.updatedAt)}`) : null,
        el("span", {}, `${conv.messages.length} ${conv.messages.length === 1 ? "message" : "messages"}`),
      ),
      el(
        "div",
        { class: "read-actions" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-line btn-small",
            onclick: () =>
              downloadBytes(`${fileSafeName(conv.title)}.md`, new TextEncoder().encode(conversationToMarkdown(conv)), "text/markdown"),
          },
          "Save as Markdown",
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn-quiet btn-small btn-danger-text",
            onclick: () =>
              confirm("Delete this chat?", `"${conv.title}" will be removed from this browser.`, "Delete chat", async () => {
                await db.remove(conv.id);
                conversations = conversations.filter((c) => c.id !== conv.id);
                location.hash = "#/";
                render();
                toast("Deleted the chat.");
              }),
          },
          "Delete chat",
        ),
      ),
    ),
    el(
      "div",
      { class: "thread" },
      conv.messages.map((message) =>
        el(
          "div",
          { class: "msg " + (message.role === "user" ? "is-user" : "is-assistant") },
          el(
            "div",
            { class: "msg-who" },
            message.role === "user" ? "You" : who,
            message.at ? el("span", { class: "msg-when" }, formatDate(message.at)) : null,
          ),
          el("div", { class: "msg-body" }, renderBody(message.text)),
        ),
      ),
    ),
  );
}

// Fenced code blocks become <pre>; everything else stays plain text.
function renderBody(text) {
  const nodes = [];
  const pieces = text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  pieces.forEach((piece, index) => {
    if (index % 2 === 1) {
      nodes.push(el("pre", {}, piece.replace(/\n$/, "")));
      return;
    }
    for (const para of piece.split(/\n{2,}/)) {
      if (para.trim()) nodes.push(el("p", {}, highlighted(para.trim(), ui.query)));
    }
  });
  return nodes;
}

// ---- Importing ----

fileInput.addEventListener("change", () => {
  // Copy the list first: clearing the input empties its FileList.
  const files = Array.from(fileInput.files);
  fileInput.value = "";
  importFiles(files);
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) return;
  dragDepth += 1;
  dropVeil.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropVeil.hidden = true;
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  if (event.dataTransfer && event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
});

async function readExportFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = listEntries(bytes);
    const wanted = pickZipEntry(entries.map((e) => e.name));
    if (!wanted) {
      const html = entries.some((e) => /myactivity\.html$/i.test(e.name));
      throw new Error(
        html
          ? "This Takeout zip has the HTML format. Make a new export with the JSON format."
          : "No conversations.json or MyActivity.json inside this zip.",
      );
    }
    return readEntryText(bytes, entries.find((e) => e.name === wanted));
  }
  return file.text();
}

async function importFiles(files) {
  files = Array.from(files || []);
  if (ui.busy || files.length === 0) return;
  ui.busy = true;
  toast("Reading the file…", 60000);
  const results = [];
  try {
    for (const file of files) {
      try {
        const text = await readExportFile(file);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`${file.name} is not a JSON export.`);
        }
        const { format, conversations: found } = parseExport(data);
        if (!format) throw new Error(`${file.name} doesn't look like a ChatGPT, Claude or Gemini export.`);
        const known = new Set(conversations.map((c) => c.id));
        const fresh = found.filter((c) => !known.has(c.id));
        await db.putMany(fresh);
        conversations.push(...fresh);
        results.push(describeImport(format, fresh.length, found.length - fresh.length));
      } catch (error) {
        results.push(error.message || "Could not read that file.");
      }
    }
  } finally {
    ui.busy = false;
  }
  ui.query = "";
  ui.shown = PAGE;
  render();
  toast(results.join(" "), 7000);
}

// ---- Exporting ----

function exportAllMarkdown() {
  const taken = new Set();
  const files = sorted().map((conv) => ({ name: conversationFileName(conv, taken), text: conversationToMarkdown(conv) }));
  downloadBytes("chatkeep-markdown.zip", writeZip(files), "application/zip");
}

function exportBackup() {
  const json = JSON.stringify({ app: "chatkeep", version: 1, conversations: sorted() });
  downloadBytes("chatkeep-backup.json", new TextEncoder().encode(json), "application/json");
}

// ---- Start ----

db.getAll()
  .then((stored) => {
    conversations = stored;
  })
  .catch(() => {
    toast("This browser blocked local storage, so chats can't be kept between visits.");
  })
  .finally(render);

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
