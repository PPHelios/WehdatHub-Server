// web/static/ximport.js — The Excel import form: the workbook is read in the browser (every tab, one at a time), and only
// the rows go to the server. Without Blob/DecompressionStream support, or for anything that is not .xlsx, the form posts
// the file as before.
(function () {
  "use strict";
  var form = document.querySelector("form[data-xi]");
  if (!form || typeof ZipRead === "undefined" || typeof XlsxRead === "undefined" || typeof DecompressionStream === "undefined") return;
  var ar = document.documentElement.lang === "ar";
  var TEXT = ar
    ? { reading: "بنقرأ الملف في المتصفح…", tab: "تاب", of: "من", sending: "بنبعت الصفوف…", fail: "مقدرناش نقرأ الملف. جرب تحفظه تاني كـ .xlsx.", net: "حصلت مشكلة في الاتصال. جرب تاني." }
    : { reading: "Reading the file in your browser…", tab: "Tab", of: "of", sending: "Sending the rows…", fail: "Could not read the file. Try saving it again as .xlsx.", net: "A connection problem. Try again." };
  var status = form.querySelector("[data-xi-status]");
  var bar = document.createElement("progress");
  bar.max = 1;
  bar.hidden = true;
  if (status) status.parentNode.insertBefore(bar, status);
  var button = form.querySelector("button[type=submit]");
  var say = function (msg, bad) {
    if (!status) return;
    status.textContent = msg;
    status.className = "card notice" + (bad ? " bad" : "");
    status.hidden = false;
  };

  form.addEventListener("submit", async function (ev) {
    var input = form.querySelector("input[type=file]");
    var file = input && input.files && input.files[0];
    if (!file || !/\.xlsx$/i.test(file.name)) return; // the server path
    ev.preventDefault();
    if (button) button.disabled = true;
    bar.hidden = false;
    bar.removeAttribute("value");
    try {
      say(TEXT.reading);
      var zip = await ZipRead.open(file);
      var wb = await XlsxRead.readWorkbook(zip, {
        onProgress: function (p) {
          // The bar and the message follow the rows of the whole workbook, with the tab being read.
          var pct = p.rowsTotal ? Math.min(100, Math.round((p.rowsDone / p.rowsTotal) * 100)) : 0;
          bar.value = p.rowsTotal ? p.rowsDone / p.rowsTotal : 0;
          if (p.name) say(TEXT.reading + " " + pct + "% (" + TEXT.tab + " " + (p.tabsDone + 1) + " " + TEXT.of + " " + p.tabsTotal + ": " + p.name + ")");
        }
      });
      if (!wb.tabs.length) {
        say(TEXT.fail, true);
        return;
      }
      say(TEXT.sending);
      bar.removeAttribute("value");
      var r = await fetch(form.getAttribute("data-grid-url"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": form.querySelector("input[name=_csrf]").value },
        body: JSON.stringify({ filename: file.name, tabs: wb.tabs })
      });
      var data = await r.json().catch(function () { return {}; });
      if (r.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      say(data.message || TEXT.net, true);
    } catch (e) {
      say(e && (e.code === "NOT_ZIP" || e.code === "NOT_XLSX" || e.code === "BAD_ENTRY") ? TEXT.fail : TEXT.net, true);
    } finally {
      bar.hidden = true;
      if (button) button.disabled = false;
    }
  });
})();
