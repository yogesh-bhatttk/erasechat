// Advanced filters + CSV/JSON export shared by the five non-Slack dashboards
// (Reddit, X, Mastodon, Teams, Telegram). Loaded as a classic <script> AFTER
// ../../shared-filters.js (isSafeRegex) and ./dashboard-fetch-utils.js (t,
// logActivity), so everything here is a plain global in the page -- and, under
// `node --test`, a CommonJS export (see the bottom of the file).
//
// Every top-level name is prefixed (af*/AF_*) or part of the public API below:
// classic scripts share ONE global lexical scope, so a second top-level
// `const MAX_REGEX_INPUT` here would be a SyntaxError that takes the whole page
// down. Nothing runs at load time -- a dashboard that never calls
// mountAdvancedFilters()/mountExportButtons() is completely unaffected.
//
// Pure functions (buildTextMatcher, passesAdvancedFilters, describeActiveFilters,
// parseCsv, csvRows, parseAdvancedFilterValues) never touch the DOM; the DOM ones
// (mount*, readAdvancedFilters, downloadTextFile) no-op without a document.

// Same deterministic ReDoS backstop as shared-filters.js's MAX_REGEX_INPUT: a regex
// only ever runs against the first 300 characters of an item's text.
const AF_MAX_REGEX_INPUT = 300;

// Localized string with the English fallback when t() (dashboard-fetch-utils.js)
// or chrome.i18n is unavailable (e.g. node tests).
function afT(key, fallback, substitutions) {
  if (typeof t === "function") return t(key, fallback, substitutions);
  return fallback;
}

// isSafeRegex comes from shared-filters.js. If it is somehow missing, treat EVERY
// pattern as unsafe (literal fallback) rather than run an unchecked user regex.
function afIsSafeRegex(pattern) {
  if (typeof isSafeRegex === "function") {
    try { return isSafeRegex(pattern); } catch (e) { return false; }
  }
  return false;
}

function afPad2(n) { return String(n).padStart(2, "0"); }

// Local-time YYYY-MM-DD (matches what an <input type=date> shows the user).
function afLocalDateString(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${afPad2(d.getMonth() + 1)}-${afPad2(d.getDate())}`;
}

// "YYYY-MM-DD" -> local Date parts, or null for anything else / an impossible date
// such as 2026-02-31 (which new Date() would silently roll into March).
function afParseDateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? "" : value).trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const probe = new Date(y, mo, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo || probe.getDate() !== d) return null;
  return { y, mo, d };
}

// ---------------------------------------------------------------------------
// Text matcher
// ---------------------------------------------------------------------------

// Returns { test(text) -> boolean, warning: null|"unsafe"|"invalid", isRegex }.
// `test` returning true means "this item matches the filter" (i.e. it is a
// deletion candidate as far as the text filter is concerned).
//
// Safety parity with Slack's qualifies() (shared-filters.js): a permanent-delete
// tool must never turn a mistyped filter into "select everything", so
//  - a regex that matches the empty string (`.*`, `a?`, `^`) selects NOTHING in
//    either mode (warning "invalid");
//  - with `invert` on, an unsafe/invalid pattern's literal fallback (which almost
//    never matches) would invert into "delete almost everything", so it selects
//    NOTHING too. Without invert the literal fallback is used as-is.
function buildTextMatcher(rawFilter, invert) {
  const raw = String(rawFilter == null ? "" : rawFilter).trim();
  if (!raw) return { test: () => true, warning: null, isRegex: false };

  const flip = !!invert;
  const toText = (text) => String(text == null ? "" : text);
  const literal = raw.toLowerCase();
  const substring = (text) => toText(text).toLowerCase().includes(literal);
  const never = () => false;

  if (raw.length > 2 && raw.startsWith("/") && raw.endsWith("/")) {
    const pattern = raw.slice(1, -1);
    let warning = null;
    let regex = null;
    if (!afIsSafeRegex(pattern)) {
      warning = "unsafe";
    } else {
      try {
        regex = new RegExp(pattern, "i");
      } catch (e) {
        warning = "invalid";
      }
    }

    if (warning) {
      if (flip) return { test: never, warning, isRegex: false };
      return { test: substring, warning, isRegex: false };
    }

    if (regex.test("")) {
      // Degenerate: matches every item. Select nothing in both modes.
      return { test: never, warning: "invalid", isRegex: true };
    }

    const matches = (text) => regex.test(toText(text).slice(0, AF_MAX_REGEX_INPUT));
    return { test: flip ? (text) => !matches(text) : matches, warning: null, isRegex: true };
  }

  return { test: flip ? (text) => !substring(text) : substring, warning: null, isRegex: false };
}

// ---------------------------------------------------------------------------
// Date / keep filters
// ---------------------------------------------------------------------------

function afToMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) value = value.getTime();
  else if (typeof value === "string" && !/^-?\d+(\.\d+)?$/.test(value)) value = Date.parse(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// accessors: { time(item) -> ms|null, score?(item) -> number|null, pinned?(item) -> boolean }
// Returns true when the item stays a deletion candidate.
function passesAdvancedFilters(item, filters, accessors) {
  const f = filters || {};
  const acc = accessors || {};

  const hasFrom = f.fromMs != null && Number.isFinite(f.fromMs);
  const hasTo = f.toMs != null && Number.isFinite(f.toMs);
  if (hasFrom || hasTo) {
    let ms = null;
    try { ms = typeof acc.time === "function" ? afToMs(acc.time(item)) : null; } catch (e) { ms = null; }
    // Unknown time can't be proven inside the range -- under-select (safe side).
    if (ms == null) return false;
    if (hasFrom && ms < f.fromMs) return false;
    if (hasTo && ms > f.toMs) return false;
  }

  if (f.keepMin != null && Number.isFinite(f.keepMin) && typeof acc.score === "function") {
    let score = null;
    try { score = acc.score(item); } catch (e) { score = null; }
    if (score != null && score !== "" && Number.isFinite(Number(score)) && Number(score) >= f.keepMin) return false;
  }

  if (f.keepPinned && typeof acc.pinned === "function") {
    let pinned = false;
    try { pinned = !!acc.pinned(item); } catch (e) { pinned = false; }
    if (pinned) return false;
  }

  return true;
}

// Pure parser behind readAdvancedFilters(): raw control values -> filters object.
function parseAdvancedFilterValues(values) {
  const v = values || {};
  const from = afParseDateParts(v.dateFrom);
  const to = afParseDateParts(v.dateTo);
  let keepMin = null;
  const rawMin = String(v.keepMin == null ? "" : v.keepMin).trim();
  if (/^\d+$/.test(rawMin)) {
    const n = Number(rawMin);
    if (Number.isSafeInteger(n) && n > 0) keepMin = n;
  }
  return {
    fromMs: from ? new Date(from.y, from.mo, from.d, 0, 0, 0, 0).getTime() : null,
    toMs: to ? new Date(to.y, to.mo, to.d, 23, 59, 59, 999).getTime() : null,
    invert: !!v.invert,
    keepMin,
    keepPinned: !!v.keepPinned
  };
}

function readAdvancedFilters() {
  if (typeof document === "undefined") return parseAdvancedFilterValues({});
  const el = (id) => document.getElementById(id);
  const val = (id) => (el(id) ? el(id).value : "");
  const checked = (id) => !!(el(id) && el(id).checked);
  return parseAdvancedFilterValues({
    dateFrom: val("af-date-from"),
    dateTo: val("af-date-to"),
    invert: checked("af-invert"),
    keepMin: val("af-keep-min"),
    keepPinned: checked("af-keep-pinned")
  });
}

// Short localized summary for the activity log ("" when nothing is active).
function describeActiveFilters(filters) {
  const f = filters || {};
  const parts = [];
  if (f.fromMs != null && Number.isFinite(f.fromMs)) {
    const d = afLocalDateString(f.fromMs);
    parts.push(afT("afSummaryFrom", `from ${d}`, [d]));
  }
  if (f.toMs != null && Number.isFinite(f.toMs)) {
    const d = afLocalDateString(f.toMs);
    parts.push(afT("afSummaryTo", `to ${d}`, [d]));
  }
  if (f.invert) parts.push(afT("afSummaryInvert", "text filter inverted"));
  if (f.keepMin != null && Number.isFinite(f.keepMin)) {
    const n = String(f.keepMin);
    parts.push(afT("afSummaryKeepMin", `keeping items scoring ${n} or more`, [n]));
  }
  if (f.keepPinned) parts.push(afT("afSummaryKeepPinned", "keeping pinned items"));
  if (!parts.length) return "";
  const joined = parts.join(", ");
  return afT("afSummary", `Extra filters: ${joined}`, [joined]);
}

// ---------------------------------------------------------------------------
// DOM: "More filters" block
// ---------------------------------------------------------------------------

function afEl(tag, attrs, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") node.className = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function afCheckboxRow(id, labelText) {
  const label = afEl("label", { className: "sc-inline-checkbox af-checkbox", for: id });
  label.appendChild(afEl("input", { type: "checkbox", id }));
  label.appendChild(afEl("span", {}, labelText));
  return label;
}

function afInputGroup(id, labelText, inputAttrs) {
  const group = afEl("div", { className: "form-group" });
  group.appendChild(afEl("label", { for: id }, labelText));
  group.appendChild(afEl("input", Object.assign({ id }, inputAttrs)));
  return group;
}

function mountAdvancedFilters(options) {
  if (typeof document === "undefined") return;
  if (document.getElementById("af-block")) return; // idempotent
  const form = document.querySelector(".filter-form");
  if (!form) return;
  const opts = options || {};

  const details = afEl("details", { className: "af-block", id: "af-block" });
  details.appendChild(afEl("summary", { className: "af-summary" }, afT("afMoreFilters", "More filters")));

  const body = afEl("div", { className: "af-body" });
  body.appendChild(afEl("p", { className: "af-hint", id: "af-regex-hint" },
    afT("afRegexHint", "Tip: wrap the text filter in slashes, e.g. /invoice|receipt/, to match a case-insensitive regular expression.")));

  const dates = afEl("div", { className: "form-row af-dates" });
  dates.appendChild(afInputGroup("af-date-from", afT("afDateFrom", "From date"), { type: "date" }));
  dates.appendChild(afInputGroup("af-date-to", afT("afDateTo", "To date (inclusive)"), { type: "date" }));
  body.appendChild(dates);

  if (typeof opts.keepMinLabel === "string" && opts.keepMinLabel.trim()) {
    body.appendChild(afInputGroup("af-keep-min", opts.keepMinLabel, {
      type: "number", min: "1", step: "1", inputmode: "numeric",
      placeholder: afT("afKeepMinPlaceholder", "Leave empty to keep none")
    }));
  }

  body.appendChild(afCheckboxRow("af-invert", afT("afInvert", "Invert text filter (keep matches, delete the rest)")));
  if (opts.keepPinned) body.appendChild(afCheckboxRow("af-keep-pinned", afT("afKeepPinned", "Keep pinned items")));

  details.appendChild(body);

  const scanBtn = document.getElementById("scan-btn");
  if (scanBtn && scanBtn.parentNode && form.contains(scanBtn)) {
    scanBtn.parentNode.insertBefore(details, scanBtn);
  } else {
    form.appendChild(details);
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180 parser: quoted fields, "" escapes, CRLF/LF/CR line breaks, line breaks
// inside quotes, leading UTF-8 BOM stripped, no phantom row for a trailing newline.
function parseCsv(text) {
  let s = String(text == null ? "" : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let rowStarted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; rowStarted = true; }
    else if (ch === ",") { row.push(field); field = ""; rowStarted = true; }
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = []; field = ""; rowStarted = false;
    } else {
      field += ch; rowStarted = true;
    }
  }
  if (rowStarted || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// One CSV cell: formula-injection-safe (same leading-character rule as content.js's
// csvSafe) and always quoted. Embedded line breaks are kept (valid inside quotes).
function afCsvCell(value) {
  let s;
  if (value == null) s = "";
  else if (value instanceof Date) s = Number.isFinite(value.getTime()) ? value.toISOString() : "";
  else if (typeof value === "object") { try { s = JSON.stringify(value); } catch (e) { s = ""; } }
  else s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function afSafeGet(col, item) {
  try { return typeof col.get === "function" ? col.get(item) : undefined; } catch (e) { return undefined; }
}

// columns: [{ label, get(item) }]. UTF-8 BOM (so Excel detects the encoding),
// CRLF line endings, header row first.
function csvRows(items, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(items) ? items : [];
  const lines = [cols.map(c => afCsvCell(c && c.label)).join(",")];
  for (const item of list) lines.push(cols.map(c => afCsvCell(afSafeGet(c, item))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Download + export buttons
// ---------------------------------------------------------------------------

function downloadTextFile(filename, text, mime) {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([String(text == null ? "" : text)], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.hidden = true;
  (document.body || document.documentElement).appendChild(a);
  try { a.click(); } finally {
    a.remove();
    // Revoke on a later tick: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function afExportFilename(platform, ext, now) {
  const slug = String(platform || "export").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `erasechat-${slug}-${afLocalDateString(now == null ? Date.now() : now)}.${ext}`;
}

function afJsonExport(items, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  return JSON.stringify((Array.isArray(items) ? items : []).map((item) => {
    const obj = {};
    for (const c of cols) {
      const v = afSafeGet(c, item);
      obj[String(c && c.label)] = v === undefined ? null : v;
    }
    return obj;
  }), null, 2);
}

// Current export wiring -- re-mounting (e.g. a dashboard re-rendering) swaps the
// columns/getItems in place instead of adding a second pair of buttons.
let afExportState = null;

function mountExportButtons(config) {
  const cfg = config || {};
  if (typeof document === "undefined") return { refresh() {} };
  const header = document.querySelector(".results-header");
  if (!header) return { refresh() {} };

  const getItems = () => {
    try {
      const items = typeof cfg.getItems === "function" ? cfg.getItems() : [];
      return Array.isArray(items) ? items : (items ? Array.from(items) : []);
    } catch (e) { return []; }
  };

  const log = (msg, level) => {
    if (typeof logActivity === "function") logActivity("sc-activity-log", msg, level);
  };

  const doExport = (kind) => {
    const items = getItems();
    if (!items.length) return;
    const filename = afExportFilename(cfg.platform, kind);
    try {
      if (kind === "csv") downloadTextFile(filename, csvRows(items, cfg.columns), "text/csv;charset=utf-8");
      else downloadTextFile(filename, afJsonExport(items, cfg.columns), "application/json;charset=utf-8");
      const n = String(items.length);
      log(afT("afExportDone", `Exported ${n} items to ${filename}`, [n, filename]));
    } catch (e) {
      const reason = (e && e.message) || String(e);
      log(afT("afExportFailed", `Export failed: ${reason}`, [reason]), "error");
    }
  };

  let csvBtn = document.getElementById("af-export-csv");
  let jsonBtn = document.getElementById("af-export-json");
  if (!csvBtn || !jsonBtn) {
    const wrap = afEl("div", { className: "af-export-actions", role: "group", "aria-label": afT("afExportGroup", "Export results") });
    csvBtn = afEl("button", { type: "button", id: "af-export-csv", className: "dashboard-btn btn-scan af-export-btn" }, afT("afExportCsv", "Export CSV"));
    jsonBtn = afEl("button", { type: "button", id: "af-export-json", className: "dashboard-btn btn-scan af-export-btn" }, afT("afExportJson", "Export JSON"));
    wrap.appendChild(csvBtn);
    wrap.appendChild(jsonBtn);
    header.appendChild(wrap);
    csvBtn.addEventListener("click", () => { if (afExportState) afExportState.doExport("csv"); });
    jsonBtn.addEventListener("click", () => { if (afExportState) afExportState.doExport("json"); });
  }

  const refresh = () => {
    const empty = getItems().length === 0;
    const hint = empty ? afT("afExportEmpty", "Nothing to export yet -- run a scan first.") : "";
    for (const btn of [csvBtn, jsonBtn]) {
      btn.disabled = empty;
      if (hint) btn.title = hint; else btn.removeAttribute("title");
    }
  };

  afExportState = { doExport };
  refresh();
  return { refresh };
}

// Export for Node (tests). In a dashboard page these stay plain globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AF_MAX_REGEX_INPUT,
    mountAdvancedFilters,
    readAdvancedFilters,
    parseAdvancedFilterValues,
    buildTextMatcher,
    passesAdvancedFilters,
    describeActiveFilters,
    parseCsv,
    csvRows,
    downloadTextFile,
    mountExportButtons,
    afExportFilename,
    afJsonExport
  };
}
