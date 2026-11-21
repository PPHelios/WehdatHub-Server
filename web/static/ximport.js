// web/static/ximport.js — The Excel import form: the workbook is read in the browser (every tab, one at a time), and only
// the rows go to the server. Without Blob/DecompressionStream support, or for anything that is not .xlsx, the form posts
// the file as before (a .csv goes that way too). The progress is real: rows read of all rows (with the tab being read), then the bytes sent, then the
// server's check of the rows; one bar for the whole run, with the numbers beside it.
(function () {
  "use strict";
  var form = document.querySelector("form[data-xi]");
  if (!form || typeof ZipRead === "undefined" || typeof XlsxRead === "undefined" || typeof DecompressionStream === "undefined") return;
  var ar = document.documentElement.lang === "ar";
  var TEXT = ar
    ? { reading: "قراءة الملف", sending: "إرسال الصفوف", checking: "مراجعة الصفوف مع المخزون", part: "الجزء", tab: "تاب", of: "من", rows: "صف", fail: "مقدرناش نقرأ الملف. جرب تحفظه تاني كـ .xlsx.", net: "حصلت مشكلة في الاتصال. جرب تاني.", keep: "سيب الصفحة مفتوحة لحد ما يخلص.", xls: "احفظ الملف كـ .xlsx وارفعه تاني.", big: "الملف كبير: امسح التابات أو الأعمدة اللي مش محتاجها." }
    : { reading: "Reading the file", sending: "Sending the rows", checking: "Checking the rows against your inventory", part: "Part", tab: "Tab", of: "of", rows: "rows", fail: "Could not read the file. Try saving it again as .xlsx.", net: "A connection problem. Try again.", keep: "Keep this page open until it finishes.", xls: "Save the file as .xlsx and try again.", big: "File too large: remove tabs or columns you don't need." };
  // The note after a split file: both languages, short. Each part is reviewed and saved on its own page.
  var NOTE = "الملف اتقسم لـ {n} أجزاء. راجع كل جزء واحفظه بالترتيب. الأكواد اللي بتتكرر بين الأجزاء بتتراجع بعد ما الأجزاء اللي قبلها تتحفظ.\nThe file was split into {n} parts. Review and save each part in order. Codes repeated across parts are checked after the earlier parts are saved.";
  var status = form.querySelector("[data-xi-status]");
  var button = form.querySelector("button[type=submit]");
  var nf = new Intl.NumberFormat(ar ? "ar-EG" : "en");

  // The progress block: stage title with the percentage, one bar, the numbers underneath.
  var box = document.createElement("div");
  box.className = "xi-progress card stack";
  box.hidden = true;
  box.setAttribute("role", "status");
  var title = document.createElement("strong");
  var bar = document.createElement("progress");
  bar.className = "pbar";
  bar.max = 100;
  bar.value = 0;
  var detail = document.createElement("p");
  detail.className = "muted";
  var keep = document.createElement("p");
  keep.className = "muted";
  keep.textContent = TEXT.keep;
  box.appendChild(title);
  box.appendChild(bar);
  box.appendChild(detail);
  box.appendChild(keep);
  if (status) status.parentNode.insertBefore(box, status);
  // The note after a split file: a card with the two-language text and a link to each part's page.
  var note = document.createElement("div");
  note.className = "card notice stack";
  note.hidden = true;
  if (status) status.parentNode.insertBefore(note, status);
  function showNote(urls, n) {
    note.textContent = "";
    NOTE.split("\n").forEach(function (line) {
      var p = document.createElement("p");
      p.textContent = line.replace(/\{n\}/g, nf.format(n));
      note.appendChild(p);
    });
    urls.forEach(function (u, i) {
      var a = document.createElement("a");
      a.href = u;
      a.className = "chip";
      a.textContent = TEXT.part + " " + (i + 1) + " " + TEXT.of + " " + n;
      note.appendChild(a);
    });
    note.hidden = false;
  }

  // The whole run is 0-100: reading the rows 0-70, sending 70-90, the server's check 90-100.
  var show = function (label, pct, text) {
    box.hidden = false;
    title.textContent = label + " · " + Math.round(pct) + "%";
    bar.value = pct;
    detail.textContent = text || "";
  };
  var say = function (msg, bad) {
    if (!status) return;
    status.textContent = msg;
    status.className = "card notice" + (bad ? " bad" : "");
    status.hidden = false;
  };
  // One request with real upload progress (fetch cannot report it).
  function send(url, token, body, onUpload) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("POST", url);
      x.withCredentials = true;
      x.setRequestHeader("Content-Type", "application/json");
      x.setRequestHeader("X-CSRF-Token", token);
      x.upload.onprogress = function (e) { if (e.lengthComputable) onUpload(e.loaded / e.total); };
      x.upload.onload = function () { onUpload(1); };
      x.onload = function () {
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) { data = {}; }
        resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, data: data });
      };
      x.onerror = function () { reject(new Error("network")); };
      x.send(body);
    });
  }

  // Columns after the last header word and empty tails are not sent (they only make the body bigger): the header is the
  // row among the first 10 with the most text cells, and it needs at least 3.
  function trim(tab) {
    var rows = tab.rows || [];
    var best = 0;
    var last = -1;
    for (var i = 0; i < Math.min(10, rows.length); i++) {
      var n = 0;
      var end = -1;
      for (var c = 0; c < rows[i].v.length; c++) if (typeof rows[i].v[c] === "string") { n++; end = c; }
      if (n > best) { best = n; last = end; }
    }
    return {
      name: tab.name,
      rows: rows.map(function (r) {
        var v = best >= 3 ? r.v.slice(0, last + 1) : r.v.slice();
        while (v.length && (v[v.length - 1] === null || v[v.length - 1] === undefined)) v.pop();
        return { n: r.n, v: v };
      })
    };
  }

  form.addEventListener("submit", async function (ev) {
    var input = form.querySelector("input[type=file]");
    var file = input && input.files && input.files[0];
    if (file && /\.xls$/i.test(file.name)) { // an old Excel file: nothing here reads it
      ev.preventDefault();
      say(TEXT.xls, true);
      return;
    }
    if (!file || !/\.xlsx$/i.test(file.name)) return; // the server path (a .csv, or anything else the server checks)
    ev.preventDefault();
    if (button) button.disabled = true;
    if (status) status.hidden = true;
    var urls = [];
    var parts = null;
    try {
      show(TEXT.reading, 0, "");
      var zip = await ZipRead.open(file);
      var wb = await XlsxRead.readWorkbook(zip, {
        onProgress: function (p) {
          var frac = p.rowsTotal ? Math.min(1, p.rowsDone / p.rowsTotal) : 0;
          var where = p.name ? " · " + TEXT.tab + " " + Math.min(p.tabsTotal, p.tabsDone + 1) + " " + TEXT.of + " " + p.tabsTotal + ": " + p.name : "";
          show(TEXT.reading, frac * 70, !p.rowsTotal ? where.replace(/^ · /, "") : nf.format(p.rowsDone) + " " + TEXT.of + " " + nf.format(p.rowsTotal) + " " + TEXT.rows + where);
        }
      });
      if (!wb.tabs.length) {
        box.hidden = true;
        say(TEXT.fail, true);
        return;
      }
      // Over the per-import cap: one import per part, posted in order, one request at a time. The whole run is 70-100 of the bar.
      parts = XlsxRead.splitParts(wb.tabs);
      var n = parts.length;
      var token = form.querySelector("input[name=_csrf]").value;
      for (var k = 0; k < n; k++) {
        var part = parts[k];
        var total = part.reduce(function (s, t) { return s + t.rows.length; }, 0);
        var lo = 70 + (30 * k) / n;
        var span = 30 / n;
        var label = n > 1 ? TEXT.part + " " + (k + 1) + " " + TEXT.of + " " + n + " · " : "";
        var name = n > 1 ? file.name + " (part " + (k + 1) + " of " + n + ")" : file.name;
        var body = JSON.stringify({ filename: name, tabs: part.map(trim), skipped: k === 0 ? wb.skipped || [] : [] });
        var mb = (body.length / 1048576).toFixed(1);
        var r = await send(form.getAttribute("data-grid-url"), token, body, function (f) {
          if (f < 1) show(label + TEXT.sending, lo + f * span * 0.7, mb + " MB · " + Math.round(f * 100) + "%");
          else show(label + TEXT.checking, lo + span * 0.9, total ? nf.format(total) + " " + TEXT.rows : "");
        });
        if (!(r.ok && r.data.url)) {
          box.hidden = true;
          var msg = r.data.message || (r.status === 413 ? TEXT.big : TEXT.net);
          if (urls.length) showNote(urls, n);
          say(label + msg, true);
          return;
        }
        urls.push(r.data.url);
      }
      box.hidden = true;
      if (n === 1) {
        window.location.href = urls[0];
        return;
      }
      showNote(urls, n);
    } catch (e) {
      box.hidden = true;
      if (urls.length) showNote(urls, parts.length);
      say(e && (e.code === "TOO_LARGE") ? TEXT.big : e && (e.code === "NOT_ZIP" || e.code === "NOT_XLSX" || e.code === "BAD_ENTRY") ? TEXT.fail : TEXT.net, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
