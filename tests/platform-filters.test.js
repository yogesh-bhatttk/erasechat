// Unit tests for platforms/shared/platform-filters.js (advanced filters + export).
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// In a dashboard page isSafeRegex is a global from shared-filters.js; mirror that.
global.isSafeRegex = require(path.join(ROOT, "shared-filters.js")).isSafeRegex;
const pf = require(path.join(ROOT, "platforms/shared/platform-filters.js"));
const {
  buildTextMatcher, passesAdvancedFilters, parseAdvancedFilterValues, readAdvancedFilters,
  describeActiveFilters, parseCsv, csvRows, mountAdvancedFilters, mountExportButtons,
  afExportFilename, afJsonExport
} = pf;

// ---------------------------------------------------------------------------
// Minimal fake DOM -- just enough for mount/read/export.
// ---------------------------------------------------------------------------
class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.className = ""; this.textContent = ""; this.value = ""; this.checked = false; this.disabled = false; this.title = "";
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); if (k === "type") this.type = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "title") this.title = ""; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
}
function makeDocument({ withForm = true, withHeader = true } = {}) {
  const doc = {
    createElement: (tag) => new FakeEl(tag, doc),
    getElementById(id) { for (const el of doc.body.walk()) if (el.id === id) return el; return null; },
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      for (const el of doc.body.walk()) if (el.className.split(/\s+/).includes(cls)) return el;
      return null;
    }
  };
  doc.body = new FakeEl("body", doc);
  doc.documentElement = doc.body;
  if (withForm) {
    const form = doc.createElement("div"); form.className = "panel-card filter-form";
    const text = doc.createElement("input"); text.setAttribute("id", "keyword");
    const scan = doc.createElement("button"); scan.setAttribute("id", "scan-btn");
    form.appendChild(text); form.appendChild(scan); doc.body.appendChild(form);
  }
  if (withHeader) {
    const header = doc.createElement("div"); header.className = "results-header";
    header.appendChild(doc.createElement("h4"));
    doc.body.appendChild(header);
  }
  return doc;
}

// ---------------------------------------------------------------------------
describe("buildTextMatcher", () => {
  test("empty / whitespace filter always matches, invert ignored", () => {
    for (const raw of ["", "   ", null, undefined]) {
      for (const inv of [false, true]) {
        const m = buildTextMatcher(raw, inv);
        assert.strictEqual(m.test("anything"), true);
        assert.strictEqual(m.test(""), true);
        assert.strictEqual(m.warning, null);
        assert.strictEqual(m.isRegex, false);
      }
    }
  });

  test("case-insensitive substring", () => {
    const m = buildTextMatcher("Hello", false);
    assert.strictEqual(m.isRegex, false);
    assert.strictEqual(m.test("say hello world"), true);
    assert.strictEqual(m.test("HELLO"), true);
    assert.strictEqual(m.test("help"), false);
    assert.strictEqual(m.test(null), false);
  });

  test("special characters are literal in substring mode", () => {
    const m = buildTextMatcher("a.b", false);
    assert.strictEqual(m.test("xa.by"), true);
    assert.strictEqual(m.test("axb"), false);
  });

  test("/regex/ is case-insensitive", () => {
    const m = buildTextMatcher("/^inv(oice)?\\d+$/", false);
    assert.strictEqual(m.isRegex, true);
    assert.strictEqual(m.warning, null);
    assert.strictEqual(m.test("INVOICE42"), true);
    assert.strictEqual(m.test("inv7"), true);
    assert.strictEqual(m.test("receipt"), false);
  });

  test("invert flips substring and regex results", () => {
    const s = buildTextMatcher("cat", true);
    assert.strictEqual(s.test("a cat"), false);
    assert.strictEqual(s.test("a dog"), true);
    const r = buildTextMatcher("/c.t/", true);
    assert.strictEqual(r.test("cut"), false);
    assert.strictEqual(r.test("dog"), true);
  });

  test("'//' and '/x' are not regexes", () => {
    assert.strictEqual(buildTextMatcher("//", false).isRegex, false);
    assert.strictEqual(buildTextMatcher("//", false).test("a//b"), true);
    assert.strictEqual(buildTextMatcher("/x", false).isRegex, false);
  });

  test("unsafe regex -> warning 'unsafe', literal fallback on the whole raw text", () => {
    const m = buildTextMatcher("/(a+)+$/", false);
    assert.strictEqual(m.warning, "unsafe");
    assert.strictEqual(m.isRegex, false);
    assert.strictEqual(m.test("aaaa"), false);
    assert.strictEqual(m.test("literal /(a+)+$/ here"), true);
  });

  test("invalid regex -> warning 'invalid', literal fallback", () => {
    const m = buildTextMatcher("/[abc/", false);
    assert.strictEqual(m.warning, "invalid");
    assert.strictEqual(m.isRegex, false);
    assert.strictEqual(m.test("a"), false);
    assert.strictEqual(m.test("x /[ABC/ y"), true);
  });

  test("unsafe/invalid + invert selects nothing (never 'delete everything')", () => {
    for (const raw of ["/(a+)+$/", "/[abc/"]) {
      const m = buildTextMatcher(raw, true);
      assert.ok(m.warning);
      assert.strictEqual(m.test("unrelated"), false);
      assert.strictEqual(m.test(raw), false);
    }
  });

  test("a regex that matches the empty string selects nothing in both modes", () => {
    for (const inv of [false, true]) {
      const m = buildTextMatcher("/.*/", inv);
      assert.strictEqual(m.warning, "invalid");
      assert.strictEqual(m.test("anything"), false);
      assert.strictEqual(m.test(""), false);
    }
  });

  test("regex input is capped to the first 300 characters", () => {
    assert.strictEqual(pf.AF_MAX_REGEX_INPUT, 300);
    const m = buildTextMatcher("/needle/", false);
    assert.strictEqual(m.test("x".repeat(290) + "needle"), true);
    assert.strictEqual(m.test("x".repeat(295) + "needle"), false);
    // Substring mode is not capped.
    assert.strictEqual(buildTextMatcher("needle", false).test("x".repeat(1000) + "needle"), true);
  });

  test("without isSafeRegex every pattern falls back to literal (fail closed)", () => {
    const saved = global.isSafeRegex;
    delete global.isSafeRegex;
    try {
      const m = buildTextMatcher("/abc/", false);
      assert.strictEqual(m.warning, "unsafe");
      assert.strictEqual(m.test("abc"), false);
    } finally {
      global.isSafeRegex = saved;
    }
  });
});

// ---------------------------------------------------------------------------
describe("passesAdvancedFilters", () => {
  const day = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const acc = { time: (i) => i.t, score: (i) => i.score, pinned: (i) => i.pinned };
  const f = parseAdvancedFilterValues({ dateFrom: "2026-03-01", dateTo: "2026-03-31" });

  test("no filters -> everything passes, including null time", () => {
    const empty = parseAdvancedFilterValues({});
    assert.strictEqual(passesAdvancedFilters({ t: null }, empty, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: 5 }, null, null), true);
  });

  test("date bounds are inclusive, to-date covers the whole day", () => {
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 1) }, f, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 31, 23, 59, 59, 999) }, f, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 31, 18) }, f, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 2, 28, 23, 59, 59, 999) }, f, acc), false);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 4, 1) }, f, acc), false);
  });

  test("single-sided bounds", () => {
    const onlyFrom = parseAdvancedFilterValues({ dateFrom: "2026-03-01" });
    assert.strictEqual(passesAdvancedFilters({ t: day(2030, 1, 1) }, onlyFrom, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: day(2020, 1, 1) }, onlyFrom, acc), false);
    const onlyTo = parseAdvancedFilterValues({ dateTo: "2026-03-01" });
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 1, 12) }, onlyTo, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 2) }, onlyTo, acc), false);
  });

  test("null / missing time fails when any date bound is set", () => {
    assert.strictEqual(passesAdvancedFilters({ t: null }, f, acc), false);
    assert.strictEqual(passesAdvancedFilters({ t: NaN }, f, acc), false);
    assert.strictEqual(passesAdvancedFilters({ t: day(2026, 3, 5) }, f, {}), false);
    assert.strictEqual(passesAdvancedFilters({}, f, { time: () => { throw new Error("x"); } }), false);
  });

  test("time accessor may return a Date or an ISO string", () => {
    assert.strictEqual(passesAdvancedFilters({ t: new Date(2026, 2, 10) }, f, acc), true);
    assert.strictEqual(passesAdvancedFilters({ t: new Date(2026, 2, 10).toISOString() }, f, acc), true);
  });

  test("keepMin excludes items scoring at or above the threshold", () => {
    const k = parseAdvancedFilterValues({ keepMin: "10" });
    assert.strictEqual(passesAdvancedFilters({ score: 9 }, k, acc), true);
    assert.strictEqual(passesAdvancedFilters({ score: 10 }, k, acc), false);
    assert.strictEqual(passesAdvancedFilters({ score: 500 }, k, acc), false);
    assert.strictEqual(passesAdvancedFilters({ score: null }, k, acc), true, "unknown score is not kept");
    assert.strictEqual(passesAdvancedFilters({ score: 50 }, k, { time: acc.time }), true, "no score accessor");
  });

  test("keepPinned excludes pinned items only when enabled", () => {
    const k = parseAdvancedFilterValues({ keepPinned: true });
    assert.strictEqual(passesAdvancedFilters({ pinned: true }, k, acc), false);
    assert.strictEqual(passesAdvancedFilters({ pinned: false }, k, acc), true);
    assert.strictEqual(passesAdvancedFilters({ pinned: true }, parseAdvancedFilterValues({}), acc), true);
  });
});

// ---------------------------------------------------------------------------
describe("parseAdvancedFilterValues / readAdvancedFilters", () => {
  test("empty / invalid values -> nulls and false", () => {
    assert.deepStrictEqual(parseAdvancedFilterValues({}),
      { fromMs: null, toMs: null, invert: false, keepMin: null, keepPinned: false });
    const bad = parseAdvancedFilterValues({ dateFrom: "2026-02-31", dateTo: "garbage", keepMin: "0" });
    assert.strictEqual(bad.fromMs, null);
    assert.strictEqual(bad.toMs, null);
    assert.strictEqual(bad.keepMin, null);
  });

  test("dates are local start/end of day", () => {
    const r = parseAdvancedFilterValues({ dateFrom: "2026-01-05", dateTo: "2026-01-05" });
    assert.strictEqual(r.fromMs, new Date(2026, 0, 5).getTime());
    assert.strictEqual(r.toMs, new Date(2026, 0, 5, 23, 59, 59, 999).getTime());
  });

  test("keepMin only accepts a positive integer", () => {
    assert.strictEqual(parseAdvancedFilterValues({ keepMin: "5" }).keepMin, 5);
    assert.strictEqual(parseAdvancedFilterValues({ keepMin: " 12 " }).keepMin, 12);
    for (const v of ["", "-3", "2.5", "abc", "1e3", "0", null, "99999999999999999999"]) {
      assert.strictEqual(parseAdvancedFilterValues({ keepMin: v }).keepMin, null, `keepMin ${v}`);
    }
  });

  describe("with a fake document", () => {
    let doc;
    beforeEach(() => { doc = makeDocument(); global.document = doc; });
    afterEach(() => { delete global.document; });

    test("readAdvancedFilters without a mounted block returns defaults", () => {
      assert.deepStrictEqual(readAdvancedFilters(),
        { fromMs: null, toMs: null, invert: false, keepMin: null, keepPinned: false });
    });

    test("mount injects the block before #scan-btn once, and read parses it", () => {
      mountAdvancedFilters({ keepMinLabel: "Keep items with at least N upvotes", keepPinned: true });
      mountAdvancedFilters({ keepMinLabel: "again", keepPinned: true });
      const form = doc.querySelector(".filter-form");
      const blocks = form.children.filter(c => c.id === "af-block");
      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(form.children.indexOf(blocks[0]), form.children.indexOf(doc.getElementById("scan-btn")) - 1);
      for (const id of ["af-date-from", "af-date-to", "af-invert", "af-keep-min", "af-keep-pinned"]) {
        assert.ok(doc.getElementById(id), `${id} exists`);
      }
      // Every control has an associated <label for>.
      const labels = [...doc.body.walk()].filter(e => e.tagName === "LABEL").map(l => l.getAttribute("for"));
      for (const id of ["af-date-from", "af-date-to", "af-invert", "af-keep-min", "af-keep-pinned"]) {
        assert.ok(labels.includes(id), `label for ${id}`);
      }
      doc.getElementById("af-date-from").value = "2026-03-01";
      doc.getElementById("af-date-to").value = "2026-03-02";
      doc.getElementById("af-invert").checked = true;
      doc.getElementById("af-keep-min").value = "7";
      doc.getElementById("af-keep-pinned").checked = true;
      assert.deepStrictEqual(readAdvancedFilters(), {
        fromMs: new Date(2026, 2, 1).getTime(),
        toMs: new Date(2026, 2, 2, 23, 59, 59, 999).getTime(),
        invert: true, keepMin: 7, keepPinned: true
      });
    });

    test("optional controls are omitted without options", () => {
      mountAdvancedFilters();
      assert.ok(doc.getElementById("af-invert"));
      assert.strictEqual(doc.getElementById("af-keep-min"), null);
      assert.strictEqual(doc.getElementById("af-keep-pinned"), null);
    });

    test("no .filter-form -> no-op", () => {
      global.document = makeDocument({ withForm: false });
      assert.doesNotThrow(() => mountAdvancedFilters({ keepPinned: true }));
      assert.strictEqual(global.document.getElementById("af-block"), null);
    });
  });

  test("DOM functions no-op without a document", () => {
    assert.strictEqual(typeof global.document, "undefined");
    assert.doesNotThrow(() => mountAdvancedFilters({ keepPinned: true }));
    assert.strictEqual(readAdvancedFilters().invert, false);
    assert.doesNotThrow(() => pf.downloadTextFile("a.txt", "x"));
    assert.doesNotThrow(() => mountExportButtons({ platform: "x", columns: [], getItems: () => [] }).refresh());
  });
});

// ---------------------------------------------------------------------------
describe("describeActiveFilters", () => {
  test("empty when nothing is active", () => {
    assert.strictEqual(describeActiveFilters(parseAdvancedFilterValues({})), "");
    assert.strictEqual(describeActiveFilters(null), "");
  });
  test("summarizes every active filter", () => {
    const s = describeActiveFilters(parseAdvancedFilterValues({
      dateFrom: "2026-03-01", dateTo: "2026-03-31", invert: true, keepMin: "10", keepPinned: true
    }));
    assert.match(s, /^Extra filters: /);
    assert.match(s, /from 2026-03-01/);
    assert.match(s, /to 2026-03-31/);
    assert.match(s, /inverted/);
    assert.match(s, /10/);
    assert.match(s, /pinned/);
  });
});

// ---------------------------------------------------------------------------
describe("parseCsv", () => {
  test("simple rows, LF and CRLF", () => {
    assert.deepStrictEqual(parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
    assert.deepStrictEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
  });
  test("trailing newline does not add an empty row; empty input -> []", () => {
    assert.deepStrictEqual(parseCsv("a\n"), [["a"]]);
    assert.deepStrictEqual(parseCsv(""), []);
    assert.deepStrictEqual(parseCsv(null), []);
  });
  test("quoted fields, escaped quotes, commas and newlines inside quotes", () => {
    assert.deepStrictEqual(parseCsv('"a,b","say ""hi""","line1\nline2","x\r\ny"\r\n2,,3'),
      [["a,b", 'say "hi"', "line1\nline2", "x\r\ny"], ["2", "", "3"]]);
  });
  test("empty fields and empty quoted field", () => {
    assert.deepStrictEqual(parseCsv(',\n""'), [["", ""], [""]]);
    assert.deepStrictEqual(parseCsv("a,"), [["a", ""]]);
  });
  test("BOM stripped", () => {
    assert.deepStrictEqual(parseCsv("﻿id,name\n1,x"), [["id", "name"], ["1", "x"]]);
  });
  test("lone CR line break", () => {
    assert.deepStrictEqual(parseCsv("a\rb"), [["a"], ["b"]]);
  });
});

// ---------------------------------------------------------------------------
describe("csvRows", () => {
  const columns = [{ label: "Id", get: (i) => i.id }, { label: "Text", get: (i) => i.text }];

  test("BOM, header, CRLF, always quoted", () => {
    const out = csvRows([{ id: 1, text: "hi" }], columns);
    assert.ok(out.startsWith("﻿"));
    assert.strictEqual(out, '﻿"Id","Text"\r\n"1","hi"\r\n');
  });

  test("formula injection is neutralized", () => {
    for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) {
      const out = csvRows([{ id: 1, text: bad }], columns);
      assert.ok(out.includes(`"'${bad}"`), `prefixed: ${JSON.stringify(bad)}`);
    }
    assert.ok(csvRows([{ id: 1, text: "a=b" }], columns).includes('"a=b"'));
  });

  test("round-trips through parseCsv (quotes, commas, newlines)", () => {
    const items = [{ id: 1, text: 'he said "yo", then\nleft' }, { id: 2, text: null }];
    assert.deepStrictEqual(parseCsv(csvRows(items, columns)),
      [["Id", "Text"], ["1", 'he said "yo", then\nleft'], ["2", ""]]);
  });

  test("throwing getters, Dates and objects", () => {
    const cols = [
      { label: "Boom", get: () => { throw new Error("x"); } },
      { label: "When", get: () => new Date(Date.UTC(2026, 0, 2)) },
      { label: "Obj", get: () => ({ a: 1 }) }
    ];
    assert.deepStrictEqual(parseCsv(csvRows([{}], cols))[1], ["", "2026-01-02T00:00:00.000Z", '{"a":1}']);
  });
});

// ---------------------------------------------------------------------------
describe("export helpers", () => {
  test("filename format", () => {
    const now = new Date(2026, 9, 9, 15).getTime();
    assert.strictEqual(afExportFilename("reddit", "csv", now), "erasechat-reddit-2026-10-09.csv");
    assert.strictEqual(afExportFilename("X / Twitter", "json", now), "erasechat-x-twitter-2026-10-09.json");
  });

  test("JSON uses column labels as keys", () => {
    const cols = [{ label: "Id", get: (i) => i.id }, { label: "Text", get: (i) => i.text }];
    assert.deepStrictEqual(JSON.parse(afJsonExport([{ id: 1, text: "=x" }], cols)), [{ Id: 1, Text: "=x" }]);
  });

  describe("mountExportButtons", () => {
    let doc, downloads, logs, savedBlob, savedCreate, savedRevoke;
    beforeEach(() => {
      doc = makeDocument(); global.document = doc;
      downloads = []; logs = [];
      savedBlob = global.Blob; savedCreate = URL.createObjectURL; savedRevoke = URL.revokeObjectURL;
      global.Blob = class { constructor(parts, opts) { this.text = parts.join(""); this.type = opts.type; } };
      URL.createObjectURL = (b) => { downloads.push(b); return "blob:x"; };
      URL.revokeObjectURL = () => {};
      global.logActivity = (id, msg, level) => logs.push({ id, msg, level });
    });
    afterEach(() => {
      delete global.document; delete global.logActivity;
      global.Blob = savedBlob; URL.createObjectURL = savedCreate; URL.revokeObjectURL = savedRevoke;
    });

    test("buttons injected once, disabled when empty, enabled after refresh", () => {
      let items = [];
      const cols = [{ label: "Id", get: (i) => i.id }];
      const ctl = mountExportButtons({ platform: "mastodon", columns: cols, getItems: () => items });
      mountExportButtons({ platform: "mastodon", columns: cols, getItems: () => items });
      const header = doc.querySelector(".results-header");
      assert.strictEqual([...header.walk()].filter(e => e.id === "af-export-csv").length, 1);
      const csv = doc.getElementById("af-export-csv");
      const json = doc.getElementById("af-export-json");
      assert.strictEqual(csv.disabled, true);
      assert.strictEqual(json.disabled, true);
      csv.click();
      assert.strictEqual(downloads.length, 0, "nothing exported while empty");

      items = [{ id: 1 }, { id: 2 }];
      ctl.refresh();
      assert.strictEqual(csv.disabled, false);
      csv.click();
      json.click();
      assert.strictEqual(downloads.length, 2);
      assert.match(downloads[0].type, /^text\/csv/);
      assert.deepStrictEqual(parseCsv(downloads[0].text), [["Id"], ["1"], ["2"]]);
      assert.deepStrictEqual(JSON.parse(downloads[1].text), [{ Id: 1 }, { Id: 2 }]);
      assert.strictEqual(logs.length, 2);
      assert.strictEqual(logs[0].id, "sc-activity-log");
      assert.match(logs[0].msg, /2 items/);
      assert.match(logs[0].msg, /erasechat-mastodon-\d{4}-\d{2}-\d{2}\.csv/);
    });

    test("getItems throwing is treated as empty", () => {
      mountExportButtons({ platform: "x", columns: [], getItems: () => { throw new Error("nope"); } });
      assert.strictEqual(doc.getElementById("af-export-csv").disabled, true);
    });

    test("no .results-header -> inert controller", () => {
      global.document = makeDocument({ withHeader: false });
      const ctl = mountExportButtons({ platform: "x", columns: [], getItems: () => [1] });
      assert.doesNotThrow(() => ctl.refresh());
      assert.strictEqual(global.document.getElementById("af-export-csv"), null);
    });
  });
});
