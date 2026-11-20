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
  const MAX_MERGE_ROWS = 2000;
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
  function parseSheet(xml, shared, onRow) {
    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm;
    let seq = 0;
    while ((rm = rowRe.exec(xml))) {
      seq++;
      if (onRow && seq % 100 === 0) onRow(seq, rowRe.lastIndex / xml.length);
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
    fillMergedDown(xml, rows);
    onRow?.(seq, 1);
    return rows;
  }

  /**
   * A vertical merge (<mergeCell ref="A2:A9"/>) holds its value only in the top cell: copy it into the cells below, on rows
   * that have other data (a merged block never invents a row). Horizontal merges and merges starting on or above the header row
   * (the row among the first 10 with the most text cells) are left alone: a label merged down from the header is not data.
   */
  function fillMergedDown(xml, rows) {
    if (!rows.length || xml.indexOf("<mergeCell") < 0) return;
    const byN = new Map(rows.map((r) => [r.n, r]));
    let header = 0;
    let most = 0;
    for (const r of rows.slice(0, 10)) {
      const n = r.v.filter((x) => typeof x === "string").length;
      if (n > most) {
        most = n;
        header = r.n;
      }
    }
    const re = /<mergeCell\b[^>]*?\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g;
    let m;
    while ((m = re.exec(xml))) {
      const col = colIndex(m[1]);
      const top = Number(m[2]);
      if (col !== colIndex(m[3]) || col >= MAX_COLS || top < 2 || top <= header) continue;
      const val = byN.get(top)?.v[col];
      if (val === null || val === undefined) continue;
      for (let n = top + 1; n <= Math.min(Number(m[4]), top + MAX_MERGE_ROWS); n++) {
        const row = byN.get(n);
        if (!row) continue;
        while (row.v.length < col) row.v.push(null);
        if (row.v[col] === null || row.v[col] === undefined) row.v[col] = val;
      }
    }
  }

  const norm = (target, base) => {
    const t = target.replace(/^\//, "");
    return t.startsWith("xl/") ? t : base + t;
  };

  /**
   * Every visible tab of a workbook.
   * @param {{ entries, text }} zip - ZipRead.open(blob)
   * @param {{ onProgress?: (info: { tabsDone: number, tabsTotal: number, rowsDone: number, rowsTotal: number, name: string }) => void }} opts
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
    const skipped = [];
    // Find the tabs to read; progress is by the bytes of each tab's XML (known from the zip directory, nothing read yet).
    const plan = [];
    let bytesTotal = 0;
    for (const s of sheets) {
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
      plan.push({ name: s.name, entry });
      bytesTotal += entry.size;
    }
    // One tab at a time: read its XML, parse it, drop the string. rowsDone counts the rows read; rowsTotal is the estimate the
    // bytes read so far imply (exact at the end), so rowsDone / rowsTotal is the share of bytes read.
    const tabs = [];
    let rowsBefore = 0;
    let bytesBefore = 0;
    const report = (i, name, rowsNow, bytesNow) => {
      const rowsDone = rowsBefore + rowsNow;
      const bytesDone = bytesBefore + bytesNow;
      const rowsTotal = bytesDone > 0 ? Math.max(rowsDone, Math.ceil((rowsDone * bytesTotal) / bytesDone)) : 0;
      onProgress?.({ tabsDone: i, tabsTotal: plan.length, rowsDone, rowsTotal, bytesDone, bytesTotal, name });
    };
    for (let i = 0; i < plan.length; i++) {
      const t = plan[i];
      report(i, t.name, 0, 0);
      let xml = await zip.text(t.entry);
      let rowsInTab = 0;
      const rows = parseSheet(xml, shared, function (seq, share) {
        rowsInTab = seq;
        report(i, t.name, seq, t.entry.size * share);
      });
      xml = null;
      rowsBefore += rowsInTab;
      bytesBefore += t.entry.size;
      if (rows.length) tabs.push({ name: t.name, rows });
      else skipped.push({ name: t.name, reason: "empty" });
    }
    onProgress?.({ tabsDone: plan.length, tabsTotal: plan.length, rowsDone: rowsBefore, rowsTotal: rowsBefore, bytesDone: bytesTotal, bytesTotal, name: "" });
    return { tabs, skipped };
  }

  return { readWorkbook, parseSheet, sharedStrings };
});
