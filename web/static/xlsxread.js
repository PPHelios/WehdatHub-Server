// web/static/xlsxread.js — Reads every tab of an .xlsx in the browser, one tab at a time, so the server never loads the
// workbook (a 4 MB workbook with 30 tabs is hundreds of MB inside a spreadsheet library). Built on zipread.js: it
// reads workbook.xml, the shared strings and each sheet's XML in turn, and returns plain grids of values.
// Also loads in Node (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XlsxRead = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_COLS = 80;
  const MAX_ROWS_PER_TAB = 6000;
  const MAX_SHEET_BYTES = 80 * 1024 * 1024; // uncompressed XML of one tab
  const fail = (code, message) => Object.assign(new Error(message), { code });

  const decode = (s) =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
    });

  const attr = (tag, name) => {
    const m = new RegExp("\\b" + name + '="([^"]*)"').exec(tag);
    return m ? decode(m[1]) : null;
  };

  /** All the <t> text of a string item, without phonetic runs. */
  function textOf(xml) {
    const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let out = "";
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(body))) out += decode(m[1]);
    return out;
  }

  function sharedStrings(xml) {
    const out = [];
    const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : "");
    return out;
  }

  const colIndex = (letters) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  /** One sheet's XML → the rows that have values: [{ n: sheet row number, v: [value | null, …] }] (column A first). */
  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm;
    let seq = 0;
    while ((rm = rowRe.exec(xml))) {
      seq++;
      if (!rm[2]) continue;
      const rAttr = /\br="(\d+)"/.exec(rm[1]);
      const n = rAttr ? Number(rAttr[1]) : seq;
      const v = [];
      let any = false;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[2]))) {
        if (!cm[2]) continue;
        const ref = /\br="([A-Z]+)\d+"/.exec(cm[1]);
        if (!ref) continue;
        const col = colIndex(ref[1]);
        if (col >= MAX_COLS) continue;
        const type = (/\bt="(\w+)"/.exec(cm[1]) || [])[1] || "n";
        let val = null;
        if (type === "inlineStr") val = textOf(cm[2]);
        else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
          if (!vm) continue;
          const raw = decode(vm[1]);
          if (type === "s") val = shared[Number(raw)] ?? null;
          else if (type === "str") val = raw;
          else if (type === "b") val = raw === "1" ? "TRUE" : "FALSE";
          else if (type === "e") val = null;
          else {
            const num = Number(raw);
            val = Number.isFinite(num) ? num : raw;
          }
        }
        if (val === null || val === undefined || (typeof val === "string" && val.trim() === "")) continue;
        v[col] = val;
        any = true;
      }
      if (any) {
        rows.push({ n, v: Array.from(v, (x) => (x === undefined ? null : x)) });
        if (rows.length >= MAX_ROWS_PER_TAB) break;
      }
    }
    return rows;
  }

  const norm = (target, base) => {
    const t = target.replace(/^\//, "");
    return t.startsWith("xl/") ? t : base + t;
  };

  /**
   * Every visible tab of a workbook.
   * @param {{ entries, text }} zip - ZipRead.open(blob)
   * @param {{ onProgress?: (info: { done: number, total: number, name: string }) => void }} opts
   * @returns {Promise<{ tabs: { name: string, rows: { n: number, v: any[] }[] }[], skipped: { name: string, reason: string }[] }>}
   * @throws {Error} code NOT_XLSX
   */
  async function readWorkbook(zip, { onProgress } = {}) {
    const find = (name) => zip.entries.find((e) => e.name === name);
    const wb = find("xl/workbook.xml");
    if (!wb) throw fail("NOT_XLSX", "Not an .xlsx workbook");
    const wbXml = await zip.text(wb);
    const relsEntry = find("xl/_rels/workbook.xml.rels");
    const rels = new Map();
    if (relsEntry) for (const m of (await zip.text(relsEntry)).matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], "Id"), attr(m[0], "Target"));
    const ssEntry = find("xl/sharedStrings.xml");
    const shared = ssEntry ? sharedStrings(await zip.text(ssEntry)) : [];

    const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], "name") || "", rid: attr(m[0], "r:id"), state: attr(m[0], "state") || "visible" }));
    const tabs = [];
    const skipped = [];
    let done = 0;
    for (const s of sheets) {
      onProgress?.({ done, total: sheets.length, name: s.name });
      done++;
      if (s.state !== "visible") {
        skipped.push({ name: s.name, reason: "hidden" });
        continue;
      }
      const target = rels.get(s.rid);
      const entry = target ? find(norm(target, "xl/")) : null;
      if (!entry) {
        skipped.push({ name: s.name, reason: "missing" });
        continue;
      }
      if (entry.size > MAX_SHEET_BYTES) {
        skipped.push({ name: s.name, reason: "too_big" });
        continue;
      }
      const rows = parseSheet(await zip.text(entry), shared);
      if (rows.length) tabs.push({ name: s.name, rows });
      else skipped.push({ name: s.name, reason: "empty" });
    }
    onProgress?.({ done: sheets.length, total: sheets.length, name: "" });
    return { tabs, skipped };
  }

  return { readWorkbook, parseSheet, sharedStrings };
});
