// web/static/unitPhotos.js — The add/edit unit form's photos. The broker sees every photo they picked (or took out of a
// WhatsApp "download all" zip), ticks which to keep, and orders them. Videos and other files are dropped with a count.
// Saving goes in the background: a warning brings the form back with the same photos still in the tray.
(function () {
  "use strict";
  var MAX = 15;
  var SIDE = 1600; // the size the server used to re-encode to (sharp): longest side, JPEG quality 82
  var QUALITY = 0.82;
  var IMAGE = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
  var MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
  var T = document.documentElement.lang === "en"
    ? { over: "{n} photo(s) not added: the limit is {max} per unit.", prep: "Preparing photos {i} of {n}…", saving: "Saving…", kept: "{n} photos, the limit is {max}. Delete {x} to save.", dropped: "{n} video or non-photo file(s) left out.", del: "🗑 Delete", zip: "Opening the zip…", zipFail: "This zip could not be opened. Pick the photos instead.", noPhotos: "No photos in this zip." }
    : { over: "{n} صورة متضافتش: الحد {max} صورة للوحدة.", prep: "بجهّز الصور {i} من {n}…", saving: "بحفظ…", kept: "عدد الصور {n} والحد {max}. امسح {x} عشان تحفظ.", dropped: "اتشال {n} فيديو أو ملف مش صورة.", del: "🗑 احذف", zip: "بفتح الزيب…", zipFail: "الزيب ده مش بيتفتح. اختار الصور عادي.", noPhotos: "مفيش صور في الزيب ده." };
  var fill = function (s, o) { return s.replace(/\{(\w+)\}/g, function (_, k) { return o[k]; }); };

  var tray = null; // { form, items: [{ file, keep, url }], dropped, busy }

  function kept() { return tray.items.length; }
  // Photos already on the unit (edit form) that are not marked for deletion count toward the limit too.
  function existing() {
    return Array.prototype.filter.call(tray.form.querySelectorAll("input[name=remove_photo]"), function (b) { return !b.checked; }).length;
  }
  function room() { return Math.max(0, MAX - existing() - tray.items.length); }

  function note(text, warn) {
    var box = tray && tray.form.querySelector("[data-photo-note]");
    if (!box) return;
    box.textContent = text || "";
    box.hidden = !text;
    box.classList.toggle("bad", Boolean(warn));
  }

  // A status line right above the Save button (the photo note sits far up the page): preparing photos with a progress bar, then saving.
  function status(form, text, done, total) {
    var p = form.querySelector("[data-save-status]");
    if (!p) {
      var btn = form.querySelector("button[type=submit], button[name=action]");
      if (!btn || !btn.parentNode) return;
      p = document.createElement("p");
      p.className = "notice";
      p.setAttribute("data-save-status", "");
      p.setAttribute("role", "status");
      btn.parentNode.insertBefore(p, btn);
    }
    p.hidden = !text;
    p.textContent = text || "";
    if (text && total) {
      var bar = document.createElement("progress");
      bar.max = total; bar.value = done; bar.style.cssText = "display:block;width:100%";
      p.appendChild(bar);
    }
  }

  // The file input is always the photos in the shown order (the compressed ones once they are ready), so the server stores exactly that.
  function sync() {
    var input = tray.form.querySelector("input[data-photo-tray]");
    if (input && window.DataTransfer) {
      var dt = new DataTransfer();
      tray.items.forEach(function (it) { dt.items.add(it.small || it.file); });
      input.files = dt.files;
    }
    var total = kept() + existing();
    var parts = [];
    if (total > MAX) parts.push(fill(T.kept, { n: total, max: MAX, x: total - MAX }));
    if (tray.over) parts.push(fill(T.over, { n: tray.over, max: MAX }));
    if (tray.dropped) parts.push(fill(T.dropped, { n: tray.dropped }));
    note(parts.join(" "), total > MAX || Boolean(tray.over));
  }

  function render() {
    var list = tray.form.querySelector("[data-photo-preview]");
    var hint = tray.form.querySelector("[data-photo-preview-hint]");
    list.innerHTML = "";
    tray.items.forEach(function (it, i) {
      var li = document.createElement("li");
      li.draggable = true;
      li.setAttribute("data-file", String(i));
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
      var del = document.createElement("button");
      del.type = "button"; del.className = "secondary"; del.setAttribute("data-delete", String(i)); del.textContent = T.del;
      li.appendChild(img); li.appendChild(name); li.appendChild(up); li.appendChild(down); li.appendChild(del);
      list.appendChild(li);
    });
    list.hidden = !tray.items.length;
    if (hint) hint.hidden = tray.items.length < 2;
    sync();
  }

  // Every photo that is going to be saved is reduced in the browser first, to what the server used to do: longest side
  // 1600 px, JPEG quality 82, rotation from the photo's own orientation applied. Anything the browser cannot read
  // (HEIC on most desktops) goes as it is and the server's fallback handles it.
  function compress(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap || !window.HTMLCanvasElement) return Promise.resolve(file);
    return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
      var k = Math.min(1, SIDE / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return new Promise(function (ok) {
        c.toBlob(function (b) {
          // A JPEG already within the size that would only get bigger stays as it is.
          if (!b || (k === 1 && file.type === "image/jpeg" && b.size >= file.size)) return ok(file);
          ok(new File([b], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }));
        }, "image/jpeg", QUALITY);
      });
    }).catch(function () { return file; });
  }

  // The photos in the tray, one at a time (phones run out of memory with many at once), with a progress bar.
  function prepare(form) {
    var items = tray.items, i = 0;
    var step = function () {
      if (i >= items.length) return Promise.resolve();
      var it = items[i];
      status(form, fill(T.prep, { i: i + 1, n: items.length }), i, items.length);
      return (it.small ? Promise.resolve(it.small) : compress(it.file)).then(function (s) { it.small = s; i++; return step(); });
    };
    return step().then(function () { sync(); });
  }

  // Only as many photos as the unit has room for are added; the rest are counted and said out loud.
  function addFiles(files, dropped) {
    var added = 0;
    var free = room();
    Array.prototype.forEach.call(files, function (f) {
      if (!IMAGE.test(f.name) && !/^image\//.test(f.type)) { tray.dropped++; return; }
      if (free <= 0) { tray.over++; return; }
      free--;
      tray.items.push({ file: f, small: null, url: null });
      added++;
    });
    tray.dropped += dropped || 0;
    if (added) { var manual = tray.form.querySelector("[data-photo-manual]"); if (manual && manual.checked) manual.checked = false; }
    render();
  }

  // The files are taken before the tray starts: starting it re-syncs (and empties) the picker, which lost the first pick.
  function fromPicker(input, files) {
    files = files || (input.files ? Array.prototype.slice.call(input.files) : []);
    if (!files.length) return;
    addFiles(files);
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
      list.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-delete]");
        if (!b) return;
        var i = Number(b.getAttribute("data-delete"));
        if (isNaN(i) || !tray.items[i]) return;
        if (tray.items[i].url) URL.revokeObjectURL(tray.items[i].url);
        tray.items.splice(i, 1);
        tray.over = 0;
        render();
      });
    }
    render();
  }

  // Each form page starts its own tray (the new unit form and the edit form).
  function start(form) {
    tray = tray && tray.form === form ? tray : { form: form, items: [], dropped: 0, over: 0 };
    tray.form = form;
    wire(form);
  }

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    var form = t.form;
    if (!form || !form.matches("#unit-form")) return;
    var picked = t.matches("input[data-photo-tray]") && t.files ? Array.prototype.slice.call(t.files) : null;
    if (!tray || tray.form !== form) start(form);
    if (t.matches("input[data-photo-tray]")) fromPicker(t, picked);
    else if (t.matches("input[data-photo-zip]")) fromZip(t);
  });

  // Saving: the photos are reduced first (with a progress bar), then an added unit goes in the background (a warning
  // brings the form back with the same photos still in the tray) and an edit is posted as a normal form.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches("#unit-form") || !window.fetch || !window.DOMParser) return;
    var edit = /\/edit$/.test((form.getAttribute("action") || location.href) || "");
    if (!tray || tray.form !== form) start(form);
    // An edit with no new photos is just a normal post.
    if (edit && !tray.items.length) return;
    e.preventDefault();
    if (kept() + existing() > MAX) {
      sync();
      var box = form.querySelector("[data-photo-note]");
      if (box && box.scrollIntoView) box.scrollIntoView({ block: "center" });
      return;
    }
    var sub = e.submitter;
    var buttons = form.querySelectorAll("button[type=submit], button[name=action]");
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    var unlock = function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); };
    prepare(form).then(function () {
      status(form, T.saving, 0, 0);
      if (edit) {
        // Disabled buttons do not send their name, so it goes as a hidden field.
        if (sub && sub.name) {
          var hid = document.createElement("input");
          hid.type = "hidden"; hid.name = sub.name; hid.value = sub.value;
          form.appendChild(hid);
        }
        HTMLFormElement.prototype.submit.call(form);
        return null;
      }
      var fd = new FormData(form);
      if (sub && sub.name) fd.append(sub.name, sub.value);
      return fetch((form.getAttribute("action") || location.href), { method: "POST", body: fd, credentials: "same-origin", headers: { Accept: "text/html" } })
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
          var keepTray = tray;
          form.replaceWith(fresh);
          keepOpts.forEach(function (o) {
            var box = fresh.querySelector('[name="' + o.n + '"]');
            if (box && o.on) box.checked = true;
          });
          if (window.htmx && window.htmx.process) window.htmx.process(fresh);
          // The photos stay in the tray (already reduced) for the next try.
          tray = keepTray; tray.form = fresh; wire(fresh);
          var alert = fresh.querySelector("[role=alert]");
          if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: "center" });
        });
    }).catch(function () {
      if (edit) { unlock(); status(form, "", 0, 0); return; }
      HTMLFormElement.prototype.submit.call(form);
    });
  });
})();
