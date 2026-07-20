const API = window.CHATBOT_API_BASE || "";

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

// Bare Q/A turns sent back to the API so follow-up questions keep context.
const history = [];
let token = localStorage.getItem("chatbot_token") || "";

// Aborts the in-flight answer stream; non-null only while an answer is streaming.
let currentAbort = null;
// Guards quick non-streaming commands (notes) against double submission.
let busy = false;

const SEND_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3.4 20.4l17.8-8.4L3.4 3.6l-.01 6.53L14 12 3.39 13.87z" fill="currentColor"/>
  </svg>`;
const STOP_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>
  </svg>`;

// While an answer streams, the send button becomes a stop button.
function setStreaming(on) {
  sendBtn.classList.toggle("stop", on);
  sendBtn.setAttribute("aria-label", on ? "Stop answer" : "Send");
  sendBtn.title = on ? "Stop — or type a new question and send it right away" : "";
  sendBtn.innerHTML = on ? STOP_ICON : SEND_ICON;
}

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// fetch with the auth header; on 401, prompt for the token once and retry.
async function apiFetch(path, options = {}) {
  const doFetch = () =>
    fetch(`${API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
    });
  let resp = await doFetch();
  if (resp.status === 401) {
    token = window.prompt(
      "Enter your access token (your VDart email token, e.g. name@vdartinc.com:abc123…):"
    ) || "";
    localStorage.setItem("chatbot_token", token);
    resp = await doFetch();
  }
  return resp;
}

// Throws the friendly message out of an error response (string or {code,message}).
async function throwApiError(resp) {
  const detail = (await resp.json().catch(() => ({}))).detail;
  const message = typeof detail === "string" ? detail : detail && detail.message;
  throw new Error(message || `The server returned an error (${resp.status}).`);
}

/* --- tiny markdown renderer -------------------------------------------------
   The LLM answers in markdown (bold, bullet/numbered lists, ### headings).
   Everything is HTML-escaped FIRST, then a small whitelist of patterns is
   converted — no raw model output ever reaches innerHTML. */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let list = null; // { tag: "ul"|"ol", items: "<li>…" }
  let para = [];

  const flushPara = () => {
    if (para.length) { html += `<p>${mdInline(para.join("<br>"))}</p>`; para = []; }
  };
  const flushList = () => {
    if (list) {
      // keep the model's numbering when bullets interrupt a numbered list
      // (otherwise each <ol> fragment would restart at 1)
      const start = list.tag === "ol" && list.start > 1 ? ` start="${list.start}"` : "";
      html += `<${list.tag}${start}>${list.items}</${list.tag}>`;
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const hd = line.match(/^#{1,4}\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: "" }; }
      list.items += `<li>${mdInline(ul[1])}</li>`;
    } else if (ol) {
      flushPara();
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: "", start: parseInt(ol[1], 10) }; }
      list.items += `<li>${mdInline(ol[2])}</li>`;
    } else if (hd) {
      flushPara(); flushList();
      html += `<h4>${mdInline(hd[1])}</h4>`;
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return html;
}

/* --- message construction --------------------------------------------------- */

const BOT_AVATAR_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2l1.7 4.8L18.5 8.5l-4.8 1.7L12 15l-1.7-4.8L5.5 8.5l4.8-1.7L12 2z" fill="currentColor"/>
    <path d="M19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" fill="currentColor" opacity=".7"/>
  </svg>`;

function makeMsg(kind) {
  const msg = document.createElement("div");
  msg.className = `msg ${kind}`;
  if (kind.startsWith("bot")) {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = BOT_AVATAR_SVG;
    msg.appendChild(avatar);
  }
  chatEl.appendChild(msg);
  return msg;
}

function addMessage(kind, text) {
  const msg = makeMsg(kind);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  msg.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

// Bot bubble that renders markdown (used for streamed answers).
function addAnswerBubble() {
  const msg = makeMsg("bot");
  const bubble = document.createElement("div");
  bubble.className = "bubble md";
  msg.appendChild(bubble);
  return bubble;
}

// "Thinking" indicator: three animated dots.
function addTyping() {
  const msg = makeMsg("bot typing");
  const bubble = document.createElement("div");
  bubble.className = "bubble dots";
  bubble.setAttribute("aria-label", "Searching postings");
  bubble.innerHTML = "<span></span><span></span><span></span>";
  msg.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
  return msg;
}

function addSources(bubble, jobs) {
  if (!jobs || !jobs.length) return;
  const wrap = document.createElement("div");
  wrap.className = "sources";
  for (const job of jobs) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = job.job_id;
    chip.title = `${job.title} — click to add a note`;
    chip.addEventListener("click", () => {
      input.value = `/note ${job.job_id} `;
      input.focus();
    });
    wrap.appendChild(chip);
  }
  bubble.appendChild(wrap);
}

const NOTE_CMD_RE = /^\/note\s+([A-Za-z]+\d+)\s+([\s\S]+)$/;
const NOTES_LIST_RE = /^\/notes\s+([A-Za-z]+\d+)$/;
const NOTE_DEL_RE = /^\/note-delete\s+(\d+)$/;
const BOOLEAN_CMD_RE = /^\/boolean\s+([A-Za-z]+\d+)\s*$/;

// Animated success card shown after a note is saved.
function addNoteCard(data, noteText) {
  const msg = makeMsg("bot");
  const card = document.createElement("div");
  card.className = "note-card";

  card.innerHTML = `
    <div class="note-check">
      <svg viewBox="0 0 52 52" aria-hidden="true">
        <circle class="nc-circle" cx="26" cy="26" r="23" fill="none"/>
        <path class="nc-tick" fill="none" d="M15 27l8 8 15-16"/>
      </svg>
    </div>
    <div class="note-body">
      <div class="note-title">Note added</div>
      <div class="note-job"></div>
      <div class="note-text"></div>
    </div>`;

  const jobLine = card.querySelector(".note-job");
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = data.job_id;
  jobLine.appendChild(chip);
  jobLine.appendChild(document.createTextNode(` ${data.title}`));

  card.querySelector(".note-text").textContent = `“${noteText}”`;

  if (data.redactions) {
    const maskedLine = document.createElement("div");
    maskedLine.className = "note-masked";
    maskedLine.textContent =
      `\u{1F512} ${data.redactions} contact detail(s) masked for privacy`;
    card.querySelector(".note-body").appendChild(maskedLine);
  }

  msg.appendChild(card);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function addNote(jobId, noteText) {
  addMessage("user", `/note ${jobId} ${noteText}`);
  try {
    const resp = await apiFetch("/api/notes", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId.toUpperCase(), note: noteText }),
    });
    if (!resp.ok) await throwApiError(resp);
    addNoteCard(await resp.json(), noteText);
  } catch (err) {
    addMessage("error", `Could not save the note: ${err.message}`);
  }
}

async function listNotes(jobId) {
  addMessage("user", `/notes ${jobId}`);
  try {
    const resp = await apiFetch(`/api/notes/${jobId.toUpperCase()}`);
    if (!resp.ok) await throwApiError(resp);
    const data = await resp.json();
    if (!data.notes.length) {
      addMessage("bot", `No notes on ${data.job_id} — ${data.title} yet. Add one with /note ${data.job_id} <text>.`);
      return;
    }
    const lines = data.notes.map((n) =>
      `#${n.id} · ${n.created_at}${n.author ? ` · ${n.author}` : ""}: ${n.note}`);
    addMessage("bot",
      `Notes on ${data.job_id} — ${data.title}:\n\n${lines.join("\n")}\n\n` +
      `To remove one: /note-delete <number>. To replace, delete it and add a new /note.`);
  } catch (err) {
    addMessage("error", `Could not load notes: ${err.message}`);
  }
}

async function deleteNote(noteId) {
  addMessage("user", `/note-delete ${noteId}`);
  try {
    const resp = await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" });
    if (!resp.ok) await throwApiError(resp);
    const data = await resp.json();
    addMessage("bot", `Note #${data.deleted} removed from ${data.job_id}. It is no longer part of that job's info.`);
  } catch (err) {
    addMessage("error", `Could not delete the note: ${err.message}`);
  }
}

// Platform-appropriate syntax for a (possibly recruiter-edited) Boolean string
// (Phase 4, AC-08). LinkedIn people search takes full native boolean — explicit
// AND, quotes, parentheses — as-is. Google X-ray uses IMPLICIT AND: Google reads
// a space as AND and the literal keyword is redundant and can behave
// inconsistently, so we drop it while keeping OR/quotes/parentheses, prefixed
// with the site: filter (Google=LinkedIn profiles, Dice=IT/defense,
// Indeed=high-volume).
function toXray(value) {
  // NOT (a OR "b c") -> -a -"b c"  (Google exclusion), then implicit AND.
  return value
    .replace(/\s+NOT\s+\(([^)]*)\)/gi, (_, inner) =>
      " " + inner.split(/\s+OR\s+/).map((t) => "-" + t.trim()).filter((t) => t.length > 1).join(" "))
    .replace(/\s+AND\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Fire-and-forget analytics for recruiter search actions/edits (Phase 6 /
// spec §13). Query is masked Boolean text — no candidate data. Errors ignored.
function logFeedback(jobId, action, platform, query) {
  fetch(`${API}/api/boolean/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ job_id: jobId.toUpperCase(), action, platform, query }),
  }).catch(() => {});
}

// AC-15 guardrail: never slice on a protected attribute. Substring match on a
// small denylist; if any term trips it, slicing is disabled for that strategy.
const PROTECTED_TERMS = [
  "male", "female", " man", "woman", "age ", "aged", "young", "elderly", "race",
  "religio", "nationalit", "pregnan", "disab", "gender", "citizen", "visa status",
  "married", "widow", "ethnic",
];
function hasProtected(groups) {
  const hay = " " + groups.flatMap((g) => g.terms).join("  ").toLowerCase() + " ";
  return PROTECTED_TERMS.some((p) => hay.includes(p));
}
function negativeClause(terms) {
  return terms.length ? " NOT (" + terms.map(quoteTerm).join(" OR ") + ")" : "";
}

// "Find a different segment" (spec §8.3): from CORE + optional signals D,E,
// build alternate (CORE AND D NOT E) and hidden (CORE NOT (D OR E)) segments.
// Degrades to one alternate when there are only two groups.
function buildSlices(groups) {
  const active = groups.filter((g) => g.terms.length);
  if (active.length < 2) return [];
  const E = active[active.length - 1];
  if (active.length >= 3) {
    const D = active[active.length - 2];
    const core = active.slice(0, active.length - 2);
    return [
      { label: "Alternate segment", note: "core + one signal, excluding the other",
        string: assembleTiers([...core, D]) + negativeClause(E.terms) },
      { label: "Hidden segment", note: "core only, excluding both signals",
        string: assembleTiers(core) + negativeClause([...D.terms, ...E.terms]) },
    ];
  }
  const core = active.slice(0, active.length - 1);
  return [
    { label: "Alternate segment", note: "excluding the last signal",
      string: assembleTiers(core) + negativeClause(E.terms) },
  ];
}

function googleXray(site, value) {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${site} ${toXray(value)}`)}`;
}

function searchUrls(value) {
  return {
    linkedin: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(value)}`,
    google: googleXray("linkedin.com/in", value),
    dice: googleXray("dice.com", value),
    indeed: googleXray("indeed.com", value),
  };
}

function mkAction(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tier-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function flashBtn(btn, msg) {
  const orig = btn.dataset.label || btn.textContent;
  btn.dataset.label = orig;
  btn.textContent = msg;
  btn.classList.add("flashed");
  setTimeout(() => { btn.textContent = orig; btn.classList.remove("flashed"); }, 1500);
}

function quoteTerm(t) { return /\s/.test(t) ? `"${t}"` : t; }

// OR within each group, AND between non-empty groups — mirrors _join_groups in
// workers/chat.py so recruiter edits re-assemble identically.
function assembleTiers(groups) {
  return groups
    .filter((g) => g.terms.length)
    .map((g) => "(" + g.terms.map(quoteTerm).join(" OR ") + ")")
    .join(" AND ");
}

// Heuristic narrow/broad warning (AC-10) from the live group state.
function tierWarning(groups) {
  const active = groups.filter((g) => g.terms.length);
  if (!active.length) return "This search is empty — restore a term to use it.";
  const total = active.reduce((n, g) => n + g.terms.length, 0);
  const minSize = Math.min(...active.map((g) => g.terms.length));
  if (active.length >= 3 && minSize === 1)
    return "⚠ Quite strict: a single-term group AND-ed with others can miss good candidates — add alternatives (OR) or drop a group.";
  if (active.length <= 1 || total <= 2)
    return "⚠ Quite broad: few constraints may return a large, noisy pool — add a group or more specific terms.";
  return "";
}

// One tier: numbered name (+Recommended badge), expected-result line, an
// editable string, class-labeled removable term chips (Phase 5) that
// re-assemble the string live, and Copy / Edit / Search actions.
function addTierBlock(container, tier, jobId) {
  const block = document.createElement("div");
  block.className = "tier-block" + (tier.recommended ? " recommended" : "");

  const head = document.createElement("div");
  head.className = "tier-head";
  const label = document.createElement("span");
  label.className = "tier-label";
  label.textContent = `[${tier.number}] ${tier.name}`;
  head.appendChild(label);
  if (tier.recommended) {
    const badge = document.createElement("span");
    badge.className = "tier-badge";
    badge.textContent = "Recommended";
    head.appendChild(badge);
  }
  block.appendChild(head);

  // "Expected result: <pool> · <relevance>" — static per tier.
  const expected = document.createElement("div");
  expected.className = "tier-expected";
  const eLabel = document.createElement("span");
  eLabel.className = "tier-expected-label";
  eLabel.textContent = "Expected result: ";
  expected.appendChild(eLabel);
  expected.appendChild(document.createTextNode(`${tier.pool} · ${tier.relevance}`));
  block.appendChild(expected);

  // Mutable local copy of the structured groups (Phase 5 editing).
  const groups = (tier.groups || []).map((g) => ({ ...g, terms: [...g.terms] }));

  const ta = document.createElement("textarea");
  ta.className = "tier-string";
  ta.value = tier.string || assembleTiers(groups);  // .value, never innerHTML
  ta.readOnly = true;
  ta.spellcheck = false;
  const sizeTa = () => { ta.rows = Math.min(6, Math.max(2, Math.ceil((ta.value.length || 1) / 64))); };
  sizeTa();
  block.appendChild(ta);

  const warn = document.createElement("div");
  warn.className = "tier-warn";
  block.appendChild(warn);

  const chipsWrap = document.createElement("div");
  chipsWrap.className = "tier-groups";
  block.appendChild(chipsWrap);

  const refresh = () => {
    ta.value = assembleTiers(groups);
    sizeTa();
    warn.textContent = tierWarning(groups);
    warn.style.display = warn.textContent ? "" : "none";
  };

  const renderChips = () => {
    chipsWrap.textContent = "";
    groups.forEach((g) => {
      if (!g.terms.length) return;
      const row = document.createElement("div");
      row.className = "tier-group";
      const glabel = document.createElement("span");
      glabel.className = "tier-group-label";
      glabel.textContent = g.label;
      if (g.why) glabel.title = g.why;   // rationale on hover (AC-17)
      row.appendChild(glabel);
      if (g.weight) {                    // recruiter weight badge (AC-11)
        const wb = document.createElement("span");
        wb.className = `weight-badge w-${g.weight.toLowerCase()}`;
        wb.textContent = g.weight;
        if (g.why) wb.title = g.why;
        row.appendChild(wb);
      }
      g.terms.forEach((term, i) => {
        const chip = document.createElement("span");
        chip.className = "term-chip";
        chip.textContent = term;
        const x = document.createElement("button");
        x.type = "button";
        x.className = "term-x";
        x.setAttribute("aria-label", `Remove ${term}`);
        x.textContent = "×";
        x.addEventListener("click", () => { g.terms.splice(i, 1); refresh(); renderChips(); });
        chip.appendChild(x);
        row.appendChild(chip);
      });
      chipsWrap.appendChild(row);
    });
  };

  // Initial warning only when we actually have structured groups to reason about.
  if (groups.length) warn.textContent = tierWarning(groups);
  warn.style.display = warn.textContent ? "" : "none";
  renderChips();

  const actions = document.createElement("div");
  actions.className = "tier-actions";

  const copyBtn = mkAction("Copy", async () => {
    try { await navigator.clipboard.writeText(ta.value); flashBtn(copyBtn, "Copied!"); }
    catch { flashBtn(copyBtn, "Copy failed"); }
  });

  let editing = false;
  const editBtn = mkAction("Edit", () => {
    editing = !editing;
    ta.readOnly = !editing;
    editBtn.textContent = editing ? "Done" : "Edit";
    editBtn.classList.toggle("active", editing);
    if (editing) { ta.focus(); ta.selectionStart = ta.value.length; }
  });

  const opener = (kind) => () => {
    logFeedback(jobId, "search", kind, ta.value);
    window.open(searchUrls(ta.value)[kind], "_blank", "noopener");
  };
  const liBtn = mkAction("Search LinkedIn", opener("linkedin"));
  liBtn.title = "LinkedIn people search (native)";
  const gBtn = mkAction("Google", opener("google"));
  gBtn.title = "Google X-ray of LinkedIn profiles (site:linkedin.com/in)";
  const diceBtn = mkAction("Dice", opener("dice"));
  diceBtn.title = "Google X-ray of Dice — IT / defense roles (site:dice.com)";
  const indeedBtn = mkAction("Indeed", opener("indeed"));
  indeedBtn.title = "Google X-ray of Indeed — high-volume roles (site:indeed.com)";

  actions.append(copyBtn, editBtn, liBtn, gBtn, diceBtn, indeedBtn);
  block.appendChild(actions);

  // --- Refinement (Phase 6): Broaden / Narrow ladder + segment slicing ------
  const slices = document.createElement("div");
  slices.className = "tier-slices";
  slices.style.display = "none";

  const dropped = [];  // groups emptied by Broaden, for Narrow to restore
  // Relax least-important first and NEVER a Primary group (AC-14).
  const RELAX_ORDER = ["Supportive", "Functional", "Anchor"];
  const broadenBtn = mkAction("Broaden", () => {
    const active = groups.filter((g) => g.terms.length);
    if (active.length <= 1) return;
    let target = null;
    for (const w of RELAX_ORDER) {
      // drop the LAST group of the highest-relax-priority weight present
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].weight === w) { target = active[i]; break; }
      }
      if (target) break;
    }
    if (!target) return;  // only Primary groups remain — nothing safe to relax
    dropped.push({ group: target, terms: [...target.terms] });
    target.terms = [];
    refresh(); renderChips();
    logFeedback(jobId, "broaden");
  });
  const narrowBtn = mkAction("Narrow", () => {
    const restore = dropped.pop();
    if (!restore) return;
    restore.group.terms = restore.terms;
    refresh(); renderChips();
    logFeedback(jobId, "narrow");
  });

  let slicesShown = false;
  const renderSlices = () => {
    slices.textContent = "";
    slices.style.display = slicesShown ? "" : "none";
    if (!slicesShown) return;
    if (hasProtected(groups)) {
      const w = document.createElement("div");
      w.className = "tier-warn";
      w.textContent = "⚠ Segment slicing disabled — a term looks like a protected attribute. Slicing must never target protected characteristics.";
      slices.appendChild(w);
      return;
    }
    const list = buildSlices(groups);
    const note = document.createElement("div");
    note.className = "slice-note";
    note.textContent = list.length
      ? "Exploratory searches that reach candidates the main search may miss. The NOT is visible — verify on the platform; never exclude protected attributes."
      : "Need at least two term groups to explore other segments.";
    slices.appendChild(note);
    list.forEach((s) => {
      const box = document.createElement("div");
      box.className = "slice";
      const h = document.createElement("div");
      h.className = "slice-label";
      h.textContent = `${s.label} — ${s.note}`;
      const code = document.createElement("code");
      code.className = "slice-string";
      code.textContent = s.string;
      const acts = document.createElement("div");
      acts.className = "tier-actions";
      const cp = mkAction("Copy", async () => {
        try { await navigator.clipboard.writeText(s.string); flashBtn(cp, "Copied!"); }
        catch { flashBtn(cp, "Copy failed"); }
      });
      const li = mkAction("LinkedIn", () => {
        logFeedback(jobId, "slice-search", "linkedin", s.string);
        window.open(searchUrls(s.string).linkedin, "_blank", "noopener");
      });
      const gg = mkAction("Google", () => {
        logFeedback(jobId, "slice-search", "google", s.string);
        window.open(searchUrls(s.string).google, "_blank", "noopener");
      });
      acts.append(cp, li, gg);
      box.append(h, code, acts);
      slices.appendChild(box);
    });
  };
  const sliceBtn = mkAction("Find a different segment", () => {
    slicesShown = !slicesShown;
    sliceBtn.classList.toggle("active", slicesShown);
    renderSlices();
  });

  const refine = document.createElement("div");
  refine.className = "tier-actions tier-refine";
  refine.append(broadenBtn, narrowBtn, sliceBtn);
  block.appendChild(refine);
  block.appendChild(slices);

  container.appendChild(block);
}

// The keyword bank table below the tiers (categories → comma-joined keywords).
function addKeywordBank(container, bank) {
  const rows = [
    ["Titles", bank.job_titles],
    ["Domain", bank.domain],
    ["Skills", bank.core_skills],
    ["Process", bank.process],
    ["Tools", bank.systems],
    ["Education", bank.education],
    ["Exclusions", bank.exclusions],
  ].filter(([, terms]) => terms && terms.length);
  if (!rows.length) return;

  const wrap = document.createElement("div");
  wrap.className = "kw-bank-wrap";
  const title = document.createElement("div");
  title.className = "kw-bank-title";
  title.textContent = "Keyword Bank";
  wrap.appendChild(title);

  const table = document.createElement("table");
  table.className = "kw-bank";
  for (const [category, terms] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = category;
    const td = document.createElement("td");
    td.textContent = terms.join(", ");
    tr.append(th, td);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// The AI's role interpretation banner + confidence + ambiguity warning +
// "Incorrect interpretation?" control that regenerates with a recruiter fix.
function addInterpretation(card, data) {
  const role = data.role || {};
  if (!role.family && !role.specialization) return;

  const box = document.createElement("div");
  box.className = "interp";

  const line = document.createElement("div");
  line.className = "interp-line";
  const label = document.createElement("span");
  label.className = "interp-label";
  label.textContent = "AI interpretation: ";
  line.appendChild(label);
  line.appendChild(document.createTextNode(
    role.specialization ? `${role.family} → ${role.specialization}` : role.family));
  if (role.confidence) {
    const conf = document.createElement("span");
    conf.className = `interp-conf ${role.confidence}`;
    conf.textContent = `${role.confidence} confidence`;
    line.appendChild(conf);
  }
  box.appendChild(line);

  const sub = [role.search_mode && `${role.search_mode}-driven`,
               role.seniority, role.industry].filter(Boolean);
  if (sub.length) {
    const subEl = document.createElement("div");
    subEl.className = "interp-sub";
    subEl.textContent = sub.join("  ·  ");
    box.appendChild(subEl);
  }

  if (role.confidence === "low" || role.wrong_role_risk) {
    const warn = document.createElement("div");
    warn.className = "interp-warn";
    warn.textContent = role.wrong_role_risk
      ? `⚠ Could be confused with: ${role.wrong_role_risk}. Verify before searching.`
      : "⚠ Ambiguous occupation — verify before searching.";
    box.appendChild(warn);
  }

  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "interp-fix";
  fix.textContent = "Incorrect interpretation?";
  fix.addEventListener("click", () => {
    const corrected = window.prompt(
      "Describe the correct occupation (e.g. \"procurement sourcing, not recruiting\"):",
      role.family || "");
    if (corrected && corrected.trim()) generateBoolean(data.job_id, corrected.trim());
  });
  box.appendChild(fix);

  card.appendChild(box);
}

// Card: three tiered Boolean strings + keyword bank for a posting.
function addBooleanCard(data) {
  const msg = makeMsg("bot");
  const card = document.createElement("div");
  card.className = "boolean-card";

  const heading = document.createElement("div");
  heading.className = "boolean-heading";
  heading.textContent = "AI-Generated Sourcing Strategy";
  card.appendChild(heading);

  // Working title = normalized market title; raw VMS title + level/grade/
  // experience are shown below for traceability (spec §3.1 / §10).
  const shownTitle = data.normalized_search_title || data.title;
  const title = document.createElement("div");
  title.className = "boolean-title";
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = data.job_id;
  title.appendChild(chip);
  title.appendChild(document.createTextNode(` ${shownTitle}`));
  card.appendChild(title);

  const titleMeta = data.title_metadata || {};
  const metaBits = ["level", "grade", "experience", "employment_type"]
    .map((k) => titleMeta[k]).filter(Boolean);
  const raw = data.raw_job_title;
  if ((raw && raw !== shownTitle) || metaBits.length) {
    const trace = document.createElement("div");
    trace.className = "boolean-trace";
    const parts = [];
    if (raw && raw !== shownTitle) parts.push(`VMS title: ${raw}`);
    parts.push(...metaBits);
    trace.textContent = parts.join("  ·  ");
    card.appendChild(trace);
  }

  addInterpretation(card, data);

  (data.tiers || []).forEach((tier) => addTierBlock(card, tier, data.job_id));
  addKeywordBank(card, data.bank || {});

  const meta = document.createElement("div");
  meta.className = "boolean-meta";
  meta.textContent =
    "Start with the Recommended string. Edit any string before searching. " +
    "Education and years of experience are screening criteria — check them separately, " +
    "not in the search.";
  card.appendChild(meta);

  msg.appendChild(card);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Staged progress for /boolean. It's a single blocking call (no token stream),
// so these messages are timed, not real progress — they reassure during the
// worst case, a ~1-3 min Qwen cold start.
function addBooleanProgress() {
  const msg = makeMsg("bot typing");
  const bubble = document.createElement("div");
  bubble.className = "bubble progress";
  const dots = document.createElement("span");
  dots.className = "progress-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  const label = document.createElement("span");
  label.className = "progress-label";
  label.textContent = "Reading the posting…";
  bubble.append(dots, label);
  msg.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;

  const stages = [
    [3000, "Generating search tiers…"],
    [9000, "Still working — the model may be waking up (first request can take a minute)…"],
    [35000, "Almost there…"],
  ];
  const timers = stages.map(([delay, text]) =>
    setTimeout(() => { label.textContent = text; }, delay));

  return { remove() { timers.forEach(clearTimeout); msg.remove(); } };
}

async function generateBoolean(jobId, roleOverride) {
  addMessage("user", roleOverride
    ? `/boolean ${jobId}  (corrected role: ${roleOverride})`
    : `/boolean ${jobId}`);
  const progress = addBooleanProgress();
  try {
    const body = { job_id: jobId.toUpperCase() };
    if (roleOverride) body.role_override = roleOverride;
    const resp = await apiFetch("/api/boolean", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) await throwApiError(resp);
    progress.remove();
    addBooleanCard(await resp.json());
  } catch (err) {
    progress.remove();
    addMessage("error", `Could not build a Boolean search: ${err.message}`);
  }
}

function postStream(question, signal) {
  return apiFetch("/api/chat/stream", {
    method: "POST",
    body: JSON.stringify({ question, history }),
    signal,
  });
}

// Minimal SSE parser over a fetch body: calls onEvent(name, dataObject).
async function readSse(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

async function send(question) {
  addMessage("user", question);
  const typing = addTyping();
  const abort = new AbortController();
  currentAbort = abort;
  setStreaming(true);

  let bubble = null;
  let jobs = [];
  let text = "";
  try {
    const resp = await postStream(question, abort.signal);
    if (!resp.ok || !resp.body) await throwApiError(resp);

    let failed = null;
    await readSse(resp, (event, data) => {
      if (event === "meta") {
        jobs = data.jobs || [];
      } else if (event === "token") {
        if (!bubble) {
          typing.remove();
          bubble = addAnswerBubble();
        }
        text += data.t;
        bubble.innerHTML = renderMarkdown(text);
        chatEl.scrollTop = chatEl.scrollHeight;
      } else if (event === "error") {
        failed = data.message || data.detail || "The answer was interrupted. Please try again.";
      }
    });
    if (failed) throw new Error(failed);
    if (!bubble) {
      typing.remove();
      bubble = addMessage("bot", "(no answer)");
    }
    // Chip only postings the answer actually cites — the meta event carries
    // the full retrieval context (up to 6 jobs), most of which may be
    // irrelevant to this particular answer.
    addSources(bubble, jobs.filter((job) => text.includes(job.job_id)));
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: text });
  } catch (err) {
    typing.remove();
    if (err.name === "AbortError") {
      // User pressed stop — keep whatever streamed so far as a normal turn.
      if (bubble) {
        addSources(bubble, jobs.filter((job) => text.includes(job.job_id)));
        const mark = document.createElement("div");
        mark.className = "stopped-note";
        mark.textContent = "Answer stopped";
        bubble.appendChild(mark);
      }
      if (text) {
        history.push({ role: "user", content: question });
        history.push({ role: "assistant", content: text });
      }
    } else {
      const message = err.message === "Failed to fetch"
        ? "Could not reach the chatbot server — check that it is running."
        : err.message;
      addMessage("error", message);
    }
  } finally {
    // A stop-and-resend may have started a newer stream already — only the
    // owner of the still-current controller resets the button state.
    if (currentAbort === abort) {
      currentAbort = null;
      setStreaming(false);
    }
  }
}

async function handleInput(question) {
  if (!question || busy || currentAbort) return;
  input.value = "";
  const noteCmd = question.match(NOTE_CMD_RE);
  const listCmd = question.match(NOTES_LIST_RE);
  const delCmd = question.match(NOTE_DEL_RE);
  if (noteCmd || listCmd || delCmd || question.startsWith("/note")) {
    busy = true;
    sendBtn.disabled = true;
    try {
      if (noteCmd) {
        await addNote(noteCmd[1], noteCmd[2].trim());
      } else if (listCmd) {
        await listNotes(listCmd[1]);
      } else if (delCmd) {
        await deleteNote(delCmd[1]);
      } else {
        addMessage("bot",
          'Note commands:\n' +
          '/note <job ID> <text> — attach call info to a job\n' +
          '/notes <job ID> — list a job’s notes with their numbers\n' +
          '/note-delete <number> — remove a note (replace = delete, then add a new /note)\n\n' +
          'Tip: click a job chip under any answer to pre-fill /note. ' +
          'Please avoid typing person names or contact details in notes.');
      }
    } finally {
      sendBtn.disabled = false;
      busy = false;
    }
  } else if (question.startsWith("/boolean")) {
    busy = true;
    sendBtn.disabled = true;
    try {
      const boolCmd = question.match(BOOLEAN_CMD_RE);
      if (boolCmd) {
        await generateBoolean(boolCmd[1]);
      } else {
        addMessage("bot",
          'Boolean sourcing:\n' +
          '/boolean <job ID> — generate LinkedIn & Google X-ray search strings ' +
          'to source candidates for a posting.\n\n' +
          'Example: /boolean NEEJP00019813');
      }
    } finally {
      sendBtn.disabled = false;
      busy = false;
    }
  } else {
    await send(question);
  }
  input.focus();
}

// Stop the in-flight answer; if a new question is already typed, send it next.
function stopAndMaybeResend() {
  const question = input.value.trim();
  currentAbort.abort();
  currentAbort = null;
  setStreaming(false);
  if (question) handleInput(question);
}

// The stop click must bypass the form: with an empty input, the field's
// `required` validation would swallow the submit event before we saw it.
sendBtn.addEventListener("click", (e) => {
  if (!currentAbort) return; // not streaming — normal form submission
  e.preventDefault();
  stopAndMaybeResend();
});

// Enter key (input is non-empty, so validation passes) and normal sends.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (currentAbort) {
    stopAndMaybeResend();
    return;
  }
  handleInput(input.value.trim());
});

/* --- dynamic homepage starter chips (VMS starter questions) ---------------- */
const STARTER_ICONS = {
  calendar: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3 9h18M8 3v3M16 3v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4l9 15.5H3L12 4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 5.2A3 3 0 0 1 16 11M20.5 19c0-2.4-1.6-4.2-3.8-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  rate: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 6.8v10.4M9.5 9c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.6-1.1 1.6-2.5 1.6-2.5.7-2.5 1.7 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const STARTER_TONE = {
  new_today: "tone-blue", opened_this_week: "tone-blue",
  needs_attention: "tone-amber",
  closing_soon: "tone-green", oldest: "tone-green",
  ready_to_source: "tone-violet", multiple_openings: "tone-violet",
  highest_rate: "tone-violet",
};

function makeStarterCard(chip) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `starter-card ${STARTER_TONE[chip.key] || "tone-blue"}`;
  const icon = document.createElement("span");
  icon.className = "starter-icon";
  icon.innerHTML = STARTER_ICONS[chip.icon] || STARTER_ICONS.calendar;
  const body = document.createElement("span");
  body.className = "starter-body";
  const t = document.createElement("span");
  t.className = "starter-title";
  t.textContent = chip.label;
  const s = document.createElement("span");
  s.className = "starter-sub";
  s.textContent = chip.sublabel;
  body.append(t, s);
  const count = document.createElement("span");
  count.className = "starter-count";
  count.textContent = chip.count;
  card.append(icon, body, count);
  card.addEventListener("click", () => runStarter(chip));
  return card;
}

// Structured, SQL-backed answer for a chip: cited Job IDs + why each appears.
function addStarterAnswer(data) {
  const msg = makeMsg("bot");
  const card = document.createElement("div");
  card.className = "starter-answer";
  const h = document.createElement("div");
  h.className = "starter-answer-title";
  h.textContent = `${data.title} · ${data.count}`;
  card.appendChild(h);
  const rows = data.rows || [];
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "starter-empty";
    empty.textContent = "Nothing matches right now.";
    card.appendChild(empty);
  } else {
    rows.slice(0, 25).forEach((r) => {
      const row = document.createElement("div");
      row.className = "starter-row";
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = r.job_id;
      chip.title = "Click to prefill /boolean";
      chip.addEventListener("click", () => { input.value = `/boolean ${r.job_id}`; input.focus(); });
      const txt = document.createElement("div");
      txt.className = "starter-row-text";
      const line = document.createElement("div");
      line.className = "starter-row-line";
      line.textContent = r.line || r.title;
      const reason = document.createElement("div");
      reason.className = "starter-row-reason";
      reason.textContent = r.reason;
      txt.append(line, reason);
      row.append(chip, txt);
      card.appendChild(row);
    });
    if (rows.length > 25) {
      const more = document.createElement("div");
      more.className = "starter-empty";
      more.textContent = `…and ${rows.length - 25} more (ask for specifics below).`;
      card.appendChild(more);
    }
  }
  msg.appendChild(card);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function runStarter(chip) {
  if (busy || currentAbort) return;
  addMessage("user", chip.question);
  const typing = addTyping();
  try {
    const resp = await apiFetch("/api/starters/answer", {
      method: "POST",
      body: JSON.stringify({ key: chip.key }),
    });
    if (!resp.ok) await throwApiError(resp);
    typing.remove();
    addStarterAnswer(await resp.json());
  } catch (err) {
    typing.remove();
    addMessage("error", `Could not load that view: ${err.message}`);
  }
}

async function loadStarters() {
  const grid = document.getElementById("starter-grid");
  const explore = document.getElementById("starter-explore");
  if (grid) {
    try {
      // auth-free counts endpoint, so chips show immediately on load
      const resp = await fetch(`${API}/api/starters`, { headers: authHeaders() });
      if (!resp.ok) throw new Error();
      const data = await resp.json();
      grid.textContent = "";
      (data.chips || []).forEach((c) => grid.appendChild(makeStarterCard(c)));
    } catch {
      grid.textContent = "";  // composer still works if this fails
    }
  }
  if (explore) {
    explore.textContent = "Explore: ";
    const links = [
      { key: "highest_rate", question: "Which open jobs have the highest bill rates?", text: "Highest rate" },
      { key: "oldest", question: "Show the oldest open jobs.", text: "Oldest jobs" },
      { text: "Search by skill or location", focus: true },
    ];
    links.forEach((it, i) => {
      const a = document.createElement("a");
      a.href = "#";
      a.className = "explore-link";
      a.textContent = it.text;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (it.focus) input.focus();
        else runStarter(it);
      });
      explore.appendChild(a);
      if (i < links.length - 1) explore.appendChild(document.createTextNode("  ·  "));
    });
  }
}

loadStarters();

// Health pill in the header — and pre-warm the LLM so the first /boolean or
// question isn't stuck behind a cold start.
fetch(`${API}/api/health`)
  .then((r) => (r.ok ? r.json().catch(() => ({})) : Promise.reject(r)))
  .then((h) => {
    statusEl.className = "status ok";
    statusEl.textContent = "Online";
    // Best-effort: skip if auth is on but we have no token yet (avoids a token
    // prompt on load), and swallow all errors — this is fire-and-forget.
    if (!h.auth || token) {
      fetch(`${API}/api/warmup`, { method: "POST", headers: authHeaders() }).catch(() => {});
    }
  })
  .catch(() => {
    statusEl.className = "status err";
    statusEl.textContent = "Offline";
  });

input.focus();
