// web/static/unitPhotos.js — The add/edit unit form's photos. The broker sees every photo they picked (or took out of a
// WhatsApp "download all" zip), ticks which to keep, and orders them. Videos and other files are dropped with a count.
// Saving goes in the background: a warning brings the form back with the same photos still in the tray.
(function () {
  "use strict";
  var MAX = 15;
  var IMAGE = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
  var MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
  var T = document.documentElement.lang === "en"
    ? { kept: "Kept {n} of {max}. Untick {x} to save.", dropped: "{n} video or non-photo file(s) left out.", zip: "Opening the zip…", zipFail: "This zip could not be opened. Pick the photos instead.", noPhotos: "No photos in this zip." }
    : { kept: "المختار {n} من {max}. شيل {x} عشان تحفظ.", dropped: "اتشال {n} فيديو أو ملف مش صورة.", zip: "بفتح الزيب…", zipFail: "الزيب ده مش بيتفتح. اختار الصور عادي.", noPhotos: "مفيش صور في الزيب ده." };
  var fill = function (s, o) { return s.replace(/\{(\w+)\}/g, function (_, k) { return o[k]; }); };

  var tray = null; // { form, items: [{ file, keep, url }], dropped, busy }

  function kept() { return tray.items.filter(function (it) { return it.keep; }).length; }

  function note(text, warn) {
    var box = tray && tray.form.querySelector("[data-photo-note]");
    if (!box) return;
    box.textContent = text || "";
    box.hidden = !text;
    box.classList.toggle("bad", Boolean(warn));
  }

  // The file input is always the kept photos in the shown order, so the server stores exactly that.
  function sync() {
    var input = tray.form.querySelector("input[data-photo-tray]");
    if (input && window.DataTransfer) {
      var dt = new DataTransfer();
      tray.items.forEach(function (it) { if (it.keep) dt.items.add(it.file); });
      input.files = dt.files;
    }
    var n = kept();
    var left = tray.dropped ? " " + fill(T.dropped, { n: tray.dropped }) : "";
    if (n > MAX) note(fill(T.kept, { n: n, max: MAX, x: n - MAX }) + left, true);
    else if (tray.dropped) note(fill(T.dropped, { n: tray.dropped }), false);
    else note("", false);
  }

  function render() {
    var list = tray.form.querySelector("[data-photo-preview]");
    var hint = tray.form.querySelector("[data-photo-preview-hint]");
    list.innerHTML = "";
    tray.items.forEach(function (it, i) {
      var li = document.createElement("li");
      li.draggable = true;
      li.setAttribute("data-file", String(i));
      if (!it.keep) li.classList.add("skip");
      var tick = document.createElement("input");
      tick.type = "checkbox"; tick.checked = it.keep; tick.setAttribute("data-keep", String(i));
      var label = document.createElement("label"); label.className = "check";
      label.appendChild(tick);
      var img = document.createElement("img");
      img.alt = ""; img.loading = "lazy";
      if (!it.url) it.url = URL.createObjectURL(it.file);
      img.src = it.url;
      var name = document.createElement("span");
      name.className = "grow";
      name.textContent = (i + 1) + ". " + it.file.name;
      var up = document.createElement("button");
      up.type = "button"; up.className = "secondary"; up.setAttribute("data-move", "up"); up.textContent = "↑";
      var down = document.createElement("button");
      down.type = "button"; down.className = "secondary"; down.setAttribute("data-move", "down"); down.textContent = "↓";
      li.appendChild(label); li.appendChild(img); li.appendChild(name); li.appendChild(up); li.appendChild(down);
      list.appendChild(li);
    });
    list.hidden = !tray.items.length;
    if (hint) hint.hidden = tray.items.length < 2;
    sync();
  }

  function addFiles(files, dropped) {
    var added = 0;
    Array.prototype.forEach.call(files, function (f) {
      if (!IMAGE.test(f.name) && !/^image\//.test(f.type)) { tray.dropped++; return; }
      // The first MAX photos are ticked when they arrive; later ones start unticked.
      tray.items.push({ file: f, keep: kept() < MAX, url: null });
      added++;
    });
    tray.dropped += dropped || 0;
    if (added) { var manual = tray.form.querySelector("[data-photo-manual]"); if (manual && manual.checked) manual.checked = false; }
    render();
  }

  function fromPicker(input) {
    if (!input.files || !input.files.length) return;
    addFiles(input.files);
    input.value = ""; // the picker is cleared; the tray holds the photos
    sync();
  }

  function fromZip(input) {
    var zipFile = input.files && input.files[0];
    input.value = "";
    if (!zipFile || !window.ZipRead) return;
    note(T.zip, false);
    window.ZipRead.open(zipFile).then(function (zip) {
      var photos = zip.entries.filter(function (e) { return IMAGE.test(e.name) && !/__MACOSX\//.test(e.name); });
      var others = zip.entries.length - photos.length;
      if (!photos.length) { note(T.noPhotos, true); return; }
      return Promise.all(photos.map(function (e) {
        return zip.blob(e).then(function (b) {
          var ext = (e.name.split(".").pop() || "").toLowerCase();
          return new File([b], e.name.split("/").pop(), { type: MIME[ext] || "image/jpeg" });
        });
      })).then(function (files) {
        files.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
        addFiles(files, others);
      });
    }).catch(function () { note(T.zipFail, true); });
  }

  function wire(form) {
    tray.form = form;
    var list = form.querySelector("[data-photo-preview]");
    if (list && !list._wired) {
      list._wired = true;
      // Dragging or the arrows: the list order is the photo order, and the broker has set the order by hand.
      list.addEventListener("sorted", function () {
        var order = Array.prototype.map.call(list.children, function (li) { return Number(li.getAttribute("data-file")); });
        tray.items = order.map(function (i) { return tray.items[i]; });
        var manual = tray.form.querySelector("[data-photo-manual]");
        if (manual) manual.checked = true;
        render();
      });
      list.addEventListener("change", function (e) {
        var i = Number(e.target.getAttribute && e.target.getAttribute("data-keep"));
        if (isNaN(i) || !tray.items[i]) return;
        tray.items[i].keep = e.target.checked;
        render();
      });
    }
    render();
  }

  // Each form page starts its own tray (the new unit form and the edit form).
  function start(form) {
    tray = tray && tray.form === form ? tray : { form: form, items: [], dropped: 0 };
    tray.form = form;
    wire(form);
  }

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    var form = t.form;
    if (!form || !form.matches("#unit-form")) return;
    if (!tray || tray.form !== form) start(form);
    if (t.matches("input[data-photo-tray]")) fromPicker(t);
    else if (t.matches("input[data-photo-zip]")) fromZip(t);
  });

  // Saving in the background: a warning brings the form back with the photos still in the tray.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches("#unit-form") || !window.fetch || !window.DOMParser) return;
    // Edit saves stay a normal form post for now (the background save is for adding a unit).
    if (/\/edit$/.test(form.getAttribute("action") || "")) return;
    if (!tray || tray.form !== form) start(form);
    e.preventDefault();
    if (kept() > MAX) { sync(); return; }
    var fd = new FormData(form);
    var sub = e.submitter;
    if (sub && sub.name) fd.append(sub.name, sub.value);
    var buttons = form.querySelectorAll("button[type=submit], button[name=action]");
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    fetch(form.action, { method: "POST", body: fd, credentials: "same-origin", headers: { Accept: "text/html" } })
      .then(function (r) {
        if (r.redirected) { location.href = r.url; return null; }
        return r.text();
      })
      .then(function (html) {
        if (html === null) return;
        var fresh = new DOMParser().parseFromString(html, "text/html").getElementById("unit-form");
        if (!fresh) { HTMLFormElement.prototype.submit.call(form); return; }
        var keepOpts = ["owner_name_from_phone", "photo_manual"].map(function (n) {
          var old = form.querySelector('[name="' + n + '"]');
          return { n: n, on: Boolean(old && old.checked) };
        });
        form.replaceWith(fresh);
        keepOpts.forEach(function (o) {
          var box = fresh.querySelector('[name="' + o.n + '"]');
          if (box && o.on) box.checked = true;
        });
        if (window.htmx && window.htmx.process) window.htmx.process(fresh);
        start(fresh);
        var alert = fresh.querySelector("[role=alert]");
        if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: "center" });
      })
      .catch(function () { HTMLFormElement.prototype.submit.call(form); });
  });
})();
