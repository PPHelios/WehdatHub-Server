// web/static/ximport.js — The Excel import form: the workbook is read in the browser (every tab, one at a time), and only
// the rows go to the server. Without Blob/DecompressionStream support, or for anything that is not .xlsx, the form posts
// the file as before. The progress is real: rows read of all rows (with the tab being read), then the bytes sent, then the
// server's check of the rows; one bar for the whole run, with the numbers beside it.
(function () {
  "use strict";
  var form = document.querySelector("form[data-xi]");
  if (!form || typeof ZipRead === "undefined" || typeof XlsxRead === "undefined" || typeof DecompressionStream === "undefined") return;
  var ar = document.documentElement.lang === "ar";
  var TEXT = ar
    ? { reading: "قراءة الملف", sending: "إرسال الصفوف", checking: "مراجعة الصفوف مع المخزون", tab: "تاب", of: "من", rows: "صف", fail: "مقدرناش نقرأ الملف. جرب تحفظه تاني كـ .xlsx.", net: "حصلت مشكلة في الاتصال. جرب تاني.", keep: "سيب الصفحة مفتوحة لحد ما يخلص." }
    : { reading: "Reading the file", sending: "Sending the rows", checking: "Checking the rows against your inventory", tab: "Tab", of: "of", rows: "rows", fail: "Could not read the file. Try saving it again as .xlsx.", net: "A connection problem. Try again.", keep: "Keep this page open until it finishes." };
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
        resolve({ ok: x.status >= 200 && x.status < 300, data: data });
      };
      x.onerror = function () { reject(new Error("network")); };
      x.send(body);
    });
  }

  form.addEventListener("submit", async function (ev) {
    var input = form.querySelector("input[type=file]");
    var file = input && input.files && input.files[0];
    if (!file || !/\.xlsx$/i.test(file.name)) return; // the server path
    ev.preventDefault();
    if (button) button.disabled = true;
    if (status) status.hidden = true;
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
      var total = wb.tabs.reduce(function (n, t) { return n + ((t.rows || t.data || []).length || 0); }, 0);
      var body = JSON.stringify({ filename: file.name, tabs: wb.tabs });
      var mb = (body.length / 1048576).toFixed(1);
      var r = await send(form.getAttribute("data-grid-url"), form.querySelector("input[name=_csrf]").value, body, function (f) {
        if (f < 1) show(TEXT.sending, 70 + f * 20, mb + " MB · " + Math.round(f * 100) + "%");
        else show(TEXT.checking, 90, total ? nf.format(total) + " " + TEXT.rows : "");
      });
      if (r.ok && r.data.url) {
        show(TEXT.checking, 100, "");
        window.location.href = r.data.url;
        return;
      }
      box.hidden = true;
      say(r.data.message || TEXT.net, true);
    } catch (e) {
      box.hidden = true;
      say(e && (e.code === "NOT_ZIP" || e.code === "NOT_XLSX" || e.code === "BAD_ENTRY") ? TEXT.fail : TEXT.net, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
