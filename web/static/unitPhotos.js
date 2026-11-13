// web/static/unitPhotos.js — The add/edit unit form's photos. The broker sees every photo they picked (or took out of a
// WhatsApp "download all" zip), ticks which to keep, and orders them. Videos and other files are dropped with a count.
// Saving goes in the background: a warning brings the form back with the same photos still in the tray.
(function () {
  "use strict";
  var MAX = 15; // kept per unit
  var POOL = 60; // picked per unit (shown as previews; only the kept ones are ever uploaded, and only at Save)
  var SIDE = 1600; // the size the server used to re-encode to (sharp): longest side, JPEG quality 82
  var QUALITY = 0.82;
  var IMAGE = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
  var MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
  var T = document.documentElement.lang === "en"
    ? { over: "{n} photo(s) not added: the limit is {max} per unit.", prep: "Preparing photos {i} of {n}…", saving: "Saving {p}%", sending: "Uploading photos…", server: "The server is saving… {s}s", checking: "Checking whether it was saved…", saved: "✅ Saved. Opening the unit…", notSaved: "⚠️ Not saved yet. Your form and photos are kept.", retry: "Try again", up: "Uploading {p}%", wait: "Waiting…", done: "✓", fail: "⚠ Failed", again: "↻ Retry", restored: "Photos you uploaded earlier were restored.", kept: "{n} photos, the limit is {max}. Delete {x} to save.", dropped: "{n} video or non-photo file(s) left out.", del: "🗑 Delete", zip: "Opening the zip…", zipFail: "This zip could not be opened. Pick the photos instead.", noPhotos: "No photos in this zip." }
    : { over: "{n} صورة متضافتش: الحد {max} صورة للوحدة.", prep: "بجهّز الصور {i} من {n}…", saving: "بحفظ {p}%", sending: "برفع الصور…", server: "السيرفر بيحفظ… {s} ث", checking: "بتأكد إنها اتحفظت…", saved: "✅ اتحفظت. بفتح الوحدة…", notSaved: "⚠️ لسه ما اتحفظتش. الفورم والصور زي ما هما.", retry: "جرب تاني", up: "برفع {p}%", wait: "مستني…", done: "✓", fail: "⚠ فشلت", again: "↻ جرب تاني", restored: "رجّعنا الصور اللي رفعتها قبل كده.", kept: "عدد الصور {n} والحد {max}. امسح {x} عشان تحفظ.", dropped: "اتشال {n} فيديو أو ملف مش صورة.", del: "🗑 احذف", zip: "بفتح الزيب…", zipFail: "الزيب ده مش بيتفتح. اختار الصور عادي.", noPhotos: "مفيش صور في الزيب ده." };
  var fill = function (s, o) { return s.replace(/\{(\w+)\}/g, function (_, k) { return o[k]; }); };
  var EN = document.documentElement.lang === "en";
  T.keepOn = EN ? "✓ Kept" : "✓ هتتحفظ"; T.keepOff = EN ? "Not kept" : "مش هتتحفظ";
  T.full = EN ? "{max} photos are kept already. Take one off first." : "الصور اللي هتتحفظ وصلت {max}. شيل واحدة الأول.";
  T.slow = EN ? "🐢 Slow connection: about {m} min left. Keep this page open." : "🐢 النت بطيء: باقي حوالي {m} دقيقة. سيب الصفحة مفتوحة.";
  T.slow0 = EN ? "🐢 Slow connection. Keep this page open until it finishes." : "🐢 النت بطيء. سيب الصفحة مفتوحة لحد ما يخلص.";
  T.picked = EN ? "{n} photos picked, {k} kept. Only kept photos are uploaded, when you save." : "اخترت {n} صورة، هتتحفظ {k}. الصور اللي هتتحفظ بس هتترفع وقت الحفظ.";

  var tray = null; // { form, items: [{ file, name, small, thumb, url, key, state, pct }], dropped, over }
  // Each photo goes straight to storage as soon as it is picked (state queued > working > done); one that cannot (a type the browser
  // cannot reduce, storage unreachable, or a failure) stays with the form and goes the old way when the unit is saved.
  var direct = true;
  var pumping = false;
  var nameOf = function (it) { return it.name || (it.file && it.file.name) || ""; };

  function chosen() { return tray.items.filter(function (it) { return it.keep; }); }
  function kept() { return chosen().length; }
  var uploading = function (x) { return x.state === "queued" || x.state === "working"; };
  // Photos already on the unit (edit form) that are not marked for deletion count toward the limit too.
  function existing() {
    return Array.prototype.filter.call(tray.form.querySelectorAll("input[name=remove_photo]"), function (b) { return !b.checked; }).length;
  }
  function room() { return Math.max(0, MAX - existing() - kept()); }

  function note(text, warn) {
    var box = tray && tray.form.querySelector("[data-photo-note]");
    if (!box) return;
    box.textContent = text || "";
    box.hidden = !text;
    box.classList.toggle("bad", Boolean(warn));
  }

  // A status line right above the Save button for the detail ("Preparing photo 4 of 15"); the percentage itself is drawn
  // inside the Save button (--p fills it), so there is one progress, not a spinner plus a bar.
  function status(form, text, kind) {
    var p = form.querySelector("[data-save-status]");
    if (!p) {
      var btn = form.querySelector("[data-save-row] button[type=submit], button[type=submit], button[name=action]");
      if (!btn || !btn.parentNode) return;
      p = document.createElement("p");
      p.setAttribute("data-save-status", "");
      p.setAttribute("role", "status");
      btn.parentNode.insertBefore(p, btn);
    }
    p.className = "notice" + (kind ? " " + kind : "");
    p.hidden = !text;
    p.textContent = text || "";
    return p;
  }

  // The Save button shows the label and the percent; the fill is its background.
  function progress(btn, pct) {
    if (!btn) return;
    if (btn._label === undefined) btn._label = btn.innerHTML;
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    btn.classList.add("saving");
    btn.style.setProperty("--p", pct + "%");
    btn.textContent = fill(T.saving, { p: pct });
  }
  function resetButton(btn) {
    if (!btn) return;
    btn.classList.remove("saving");
    btn.style.removeProperty("--p");
    if (btn._label !== undefined) { btn.innerHTML = btn._label; btn._label = undefined; }
  }

  // The file input is always the photos in the shown order (the compressed ones once they are ready), so the server stores exactly that.
  function sync() {
    var input = tray.form.querySelector("input[data-photo-tray]");
    if (input && window.DataTransfer) {
      var dt = new DataTransfer();
      chosen().forEach(function (it) { if (!it.key && it.file && !uploading(it)) dt.items.add(it.small || it.file); });
      input.files = dt.files;
    }
    // The uploaded photos are named in the form (in the shown order), so the review and the save know them.
    var keyBox = tray.form.querySelector("[data-photo-keys]");
    if (!keyBox) { keyBox = document.createElement("div"); keyBox.hidden = true; keyBox.setAttribute("data-photo-keys", ""); tray.form.appendChild(keyBox); }
    keyBox.innerHTML = "";
    chosen().forEach(function (it) {
      if (!it.key) return;
      var h = document.createElement("input");
      h.type = "hidden"; h.name = "photo_keys"; h.value = it.key;
      keyBox.appendChild(h);
    });
    // Photos still to upload at Save: the review and the Next check count them, so they never say "no photos".
    var pend = chosen().filter(function (x) { return !x.key && x.state !== "failed" && x.state !== "local"; }).length;
    var ph = document.createElement("input");
    ph.type = "hidden"; ph.name = "photo_pending"; ph.value = String(pend);
    keyBox.appendChild(ph);
    persist();
    var total = kept() + existing();
    var parts = [];
    if (total > MAX) parts.push(fill(T.kept, { n: total, max: MAX, x: total - MAX }));
    if (tray.items.length > kept()) parts.push(fill(T.picked, { n: tray.items.length, k: kept() }));
    if (tray.over) parts.push(fill(T.over, { n: tray.over, max: POOL }));
    if (tray.dropped) parts.push(fill(T.dropped, { n: tray.dropped }));
    note(parts.join(" "), total > MAX || Boolean(tray.over));
  }

  function stateText(it) {
    if (!it.keep) return T.keepOff;
    if (it.state === "done") return T.done;
    if (it.state === "failed") return T.fail;
    if (it.state === "working") return fill(T.up, { p: Math.round(it.pct || 0) });
    if (it.state === "queued") return T.wait;
    return "";
  }
  // Updates one photo's label without rebuilding the list (dragging and the picture stay as they are).
  function showState(it) {
    var list = tray && tray.form.querySelector("[data-photo-preview]");
    var i = tray ? tray.items.indexOf(it) : -1;
    var li = list && i >= 0 ? list.children[i] : null;
    var st = li && li.querySelector("[data-photo-state]");
    if (st) st.textContent = stateText(it);
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
      if (!it.url && it.file) it.url = URL.createObjectURL(it.file);
      if (it.url) img.src = it.url;
      var name = document.createElement("span");
      name.className = "grow";
      name.textContent = (i + 1) + ". " + nameOf(it);
      var st = document.createElement("span");
      st.className = "muted small"; st.setAttribute("data-photo-state", "");
      st.textContent = stateText(it);
      var up = document.createElement("button");
      up.type = "button"; up.className = "secondary"; up.setAttribute("data-move", "up"); up.textContent = "↑";
      var down = document.createElement("button");
      down.type = "button"; down.className = "secondary"; down.setAttribute("data-move", "down"); down.textContent = "↓";
      var del = document.createElement("button");
      del.type = "button"; del.className = "secondary"; del.setAttribute("data-delete", String(i)); del.textContent = T.del;
      if (!it.keep) li.className = "muted";
      var kb = document.createElement("button");
      kb.type = "button"; kb.className = "secondary small"; kb.setAttribute("data-keep", String(i)); kb.textContent = it.keep ? T.keepOn : T.keepOff;
      li.appendChild(img); li.appendChild(name); li.appendChild(st); li.appendChild(kb); if (it.state === "failed") { var rt = document.createElement("button"); rt.type = "button"; rt.className = "secondary small"; rt.setAttribute("data-retry", String(i)); rt.textContent = T.again; li.appendChild(rt); } li.appendChild(up); li.appendChild(down); li.appendChild(del);
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
    // A photo the browser cannot finish in 20 seconds goes as it is (the server's fallback handles it): saving never waits forever.
    return new Promise(function (ok) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; ok(file); } }, 20000);
      compressNow(file).then(function (f) { if (!done) { done = true; clearTimeout(t); ok(f); } }, function () { if (!done) { done = true; clearTimeout(t); ok(file); } });
    });
  }
  function compressNow(file) {
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

  // ---- Direct upload: reduce in the browser (1600 px JPEG plus a 360x270 small copy), then PUT both straight to storage.
  var csrfToken = function () { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ""; };

  function reduce(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap || !window.HTMLCanvasElement) return Promise.resolve(null);
    return new Promise(function (ok) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; ok(null); } }, 20000);
      var finish = function (v) { if (!done) { done = true; clearTimeout(t); ok(v); } };
      createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
        var k = Math.min(1, SIDE / Math.max(bmp.width, bmp.height));
        var c = document.createElement("canvas");
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        // The small copy: 360x270, cropped to fill from the middle.
        var tc = document.createElement("canvas");
        tc.width = 360; tc.height = 270;
        var scale = Math.max(360 / bmp.width, 270 / bmp.height);
        var w = 360 / scale, h = 270 / scale;
        tc.getContext("2d").drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, 360, 270);
        if (bmp.close) bmp.close();
        c.toBlob(function (b) {
          if (!b) return finish(null);
          tc.toBlob(function (tb) { finish({ small: new File([b], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }), thumb: tb || null }); }, "image/jpeg", 0.7);
        }, "image/jpeg", QUALITY);
      }).catch(function () { finish(null); });
    });
  }

  // One upload link from the server, or null (then everything goes with the form, as before).
  function signOne() {
    return fetch("/app/units/photo-upload", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() }, body: JSON.stringify({ count: 1 }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.uploads && j.uploads[0] ? j.uploads[0] : null; })
      .catch(function () { return null; });
  }

  // The same call storage's own library makes for a file: a form with the cache setting and the file, and no sign-in (the link is the permission).
  function put(url, blob, name, onFraction) {
    return new Promise(function (ok, no) {
      var xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.timeout = 120000;
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onFraction) onFraction(e.loaded / e.total); };
      xhr.onload = function () { return xhr.status >= 200 && xhr.status < 300 ? ok() : no(new Error("put " + xhr.status)); };
      xhr.onerror = function () { no(new Error("network")); };
      xhr.ontimeout = function () { no(new Error("timeout")); };
      var fd = new FormData();
      fd.append("cacheControl", "31536000");
      fd.append("", blob, name);
      xhr.send(fd);
    });
  }

  function processItem(it) {
    it.state = "working"; it.pct = 1; showState(it);
    return reduce(it.file).then(function (r) {
      if (!r) { it.state = "local"; return null; } // a type the browser cannot reduce: goes with the form
      it.small = r.small;
      return signOne().then(function (u) {
        if (!u) { direct = false; it.state = "local"; return null; }
        it.pct = 5; showState(it);
        return put(u.upload_url, r.small, "photo.jpg", function (f) { it.pct = 5 + 90 * f; showState(it); })
          .then(function () { return r.thumb && u.thumb_upload_url ? put(u.thumb_upload_url, r.thumb, "thumb.jpg").catch(function () { /* the full photo is shown instead */ }) : null; })
          .then(function () { it.key = u.key; it.state = "done"; it.pct = 100; });
      });
    }).catch(function () { it.state = "failed"; }).then(function () { showState(it); });
  }

  // One photo at a time (phones run out of memory with many); the next starts as soon as one is done.
  function pump() {
    if (pumping) return;
    pumping = true;
    (function next() {
      var it = tray && tray.items.filter(function (x) { return x.state === "queued" && x.keep; })[0];
      if (!it) { pumping = false; if (tray) sync(); return; }
      if (!direct) { it.state = "local"; showState(it); return next(); }
      processItem(it).then(function () { sync(); next(); });
    })();
  }

  // The save waits for photos still on their way; onFraction(0..1) feeds the Save button's percent.
  function settle(onFraction) {
    return new Promise(function (ok) {
      (function look() {
        var items = chosen(), pending = items.filter(uploading);
        var total = items.length || 1;
        var got = items.reduce(function (n, x) { return n + (uploading(x) ? (x.pct || 0) / 100 : 1); }, 0);
        onFraction(got / total, items.length - pending.length, items.length);
        if (!pending.length) return ok();
        pump();
        setTimeout(look, 200);
      })();
    });
  }

  // Photos uploaded before a reload or a closed tab: kept by key on this phone and checked with the server when the form reopens.
  var persistKey = function () { return tray && tray.form ? "wh-unit-photos:" + (tray.form.getAttribute("action") || "") : null; };
  function persist() {
    try {
      var k = persistKey();
      if (!k || tray.restoring || (!tray.live && !tray.items.length)) return; // not before the saved list has been read back
      var list = chosen().filter(function (x) { return x.key; }).map(function (x) { return { key: x.key, name: nameOf(x) }; });
      if (list.length) localStorage.setItem(k, JSON.stringify({ at: Date.now(), list: list })); else localStorage.removeItem(k);
    } catch (e) { /* storage may be off: the photos are simply not remembered */ }
  }
  function clearPersist() { try { var k = persistKey(); if (k) localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function restore() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(persistKey()) || "null"); } catch (e) { raw = null; }
    if (!raw || !raw.list || !raw.list.length || Date.now() - raw.at > 20 * 3600 * 1000 || tray.items.length) return;
    tray.restoring = true;
    fetch("/app/units/photo-upload/check", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() }, body: JSON.stringify({ keys: raw.list.map(function (x) { return x.key; }) }) })
      .then(function (r) { return r.ok ? r.json() : { ready: [] }; })
      .then(function (j) {
        var names = {};
        raw.list.forEach(function (x) { names[x.key] = x.name; });
        (j.ready || []).slice(0, room()).forEach(function (r) { tray.items.push({ file: null, name: names[r.key] || "photo.jpg", small: null, thumb: null, url: r.thumb || r.url, key: r.key, keep: true, state: "done", pct: 100 }); });
        tray.restoring = false;
        tray.live = true;
        render();
        if (tray.items.length) note(T.restored, false);
      })
      .catch(function () { tray.restoring = false; });
  }

  // The photos in the tray, one at a time (phones run out of memory with many at once); onStep(done, total) for the percent.
  function prepare(form, onStep) {
    var items = chosen(), i = 0;
    var step = function () {
      if (i >= items.length) return Promise.resolve();
      var it = items[i];
      if (it.key || !it.file) { i++; return step(); } // already in storage
      onStep(i, items.length);
      return (it.small ? Promise.resolve(it.small) : compress(it.file)).then(function (s) { it.small = s; i++; return step(); });
    };
    return step().then(function () { onStep(items.length, items.length); sync(); });
  }

  // Only as many photos as the unit has room for are added; the rest are counted and said out loud.
  function addFiles(files, dropped) {
    var added = 0;
    var free = room();
    Array.prototype.forEach.call(files, function (f) {
      if (!IMAGE.test(f.name) && !/^image\//.test(f.type)) { tray.dropped++; return; }
      if (tray.items.length >= POOL) { tray.over++; return; }
      var keep = free > 0;
      if (keep) free--;
      tray.live = true;
      tray.items.push({ file: f, name: f.name, small: null, thumb: null, url: null, key: null, keep: keep, state: keep ? "queued" : "idle", pct: 0 });
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
      if (photos.length > POOL) { tray.over += photos.length - POOL; photos = photos.slice(0, POOL); }
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
        var kb = e.target.closest && e.target.closest("[data-keep]");
        if (kb) {
          var ki = Number(kb.getAttribute("data-keep")), kit = tray.items[ki];
          if (!kit) return;
          if (kit.keep) kit.keep = false;
          else {
            if (room() <= 0) { note(fill(T.full, { max: MAX }), true); return; }
            kit.keep = true;
            if (!kit.key && kit.state !== "failed") kit.state = "queued";
          }
          tray.live = true;
          render();
          return;
        }
        var rb = e.target.closest && e.target.closest("[data-retry]");
        if (rb) {
          var ri = Number(rb.getAttribute("data-retry"));
          if (tray.items[ri]) { tray.items[ri].state = "queued"; direct = true; render(); pump(); }
          return;
        }
        var b = e.target.closest && e.target.closest("[data-delete]");
        if (!b) return;
        var i = Number(b.getAttribute("data-delete"));
        if (isNaN(i) || !tray.items[i]) return;
        if (tray.items[i].url) URL.revokeObjectURL(tray.items[i].url);
        tray.items.splice(i, 1);
        tray.live = true;
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

  // Saving (add and edit share this one path). The photos are reduced first, then the form goes up in the background with the
  // upload percent. The form carries a save key, so a repeated try never saves twice. If no answer comes in 60 seconds (or the
  // connection drops) the page asks the server whether that key was saved: saved shows "Saved" and opens the unit, not saved
  // shows the error with Try again and the form and photos exactly as they were.
  var CHECK_AFTER_MS = 60000;
  var busy = false;
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches("#unit-form") || !window.XMLHttpRequest || !window.DOMParser || !window.FormData) return;
    var edit = /\/edit$/.test((form.getAttribute("action") || location.href) || "");
    if (!tray || tray.form !== form) start(form);
    e.preventDefault();
    if (busy) return; // a double tap
    if (kept() + existing() > MAX) {
      sync();
      var box = form.querySelector("[data-photo-note]");
      if (box && box.scrollIntoView) box.scrollIntoView({ block: "center" });
      return;
    }
    var sub = e.submitter || form.querySelector("[data-save-row] button[type=submit]");
    var buttons = form.querySelectorAll("button[type=submit], button[name=action]");
    var keyInput = form.querySelector('input[name="save_key"]');
    var saveKey = keyInput ? keyInput.value : "";
    var action = form.getAttribute("action") || location.href;
    busy = true;
    var lock = function (on) {
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = on; });
      try { form.inert = on; } catch (x) { /* older browsers: the buttons are locked */ }
      if (on) form.setAttribute("aria-busy", "true"); else form.removeAttribute("aria-busy");
    };
    var timers = [];
    var clearTimers = function () { timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); timers = []; };
    var xhr = null;
    var pct = 0;
    var serverFrom = 0; // when the server wait began
    var failed = function (msg) {
      clearTimers();
      busy = false;
      lock(false);
      resetButton(sub);
      var p = status(form, msg, "bad");
      if (p) {
        var again = document.createElement("button");
        again.type = "button"; again.className = "secondary small"; again.textContent = T.retry;
        again.addEventListener("click", function () { status(form, ""); if (form.requestSubmit) form.requestSubmit(sub && sub.form === form ? sub : undefined); else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); });
        p.appendChild(document.createTextNode(" "));
        p.appendChild(again);
        if (p.scrollIntoView) p.scrollIntoView({ block: "center" });
      }
    };
    // Asks whether this save went through. The check is a plain read: nothing is saved or changed by asking.
    var checkSaved = function () {
      status(form, T.checking);
      return fetch("/app/units/save-status?key=" + encodeURIComponent(saveKey), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : { saved: false }; })
        .catch(function () { return { saved: false }; })
        .then(function (j) {
          if (j && j.saved && j.code) {
            clearTimers();
            if (xhr) { try { xhr.abort(); } catch (x) { /* already done */ } }
            progress(sub, 100);
            clearPersist();
            window.__whSaved = true;
            status(form, T.saved, "ok");
            report("recovered");
            location.assign("/app/units/" + encodeURIComponent(j.code) + "?saved=1");
            return true;
          }
          return false;
        });
    };
    var t0 = Date.now();
    // The browser tells the server how the save went and how long the broker waited (no unit content), so slow or lost
    // saves show up in the logs. One row per save: ok, refused, recovered (answer lost, check found it), timeout, network.
    var report = function (outcome) {
      try {
        var meta = document.querySelector('meta[name="csrf-token"]');
        fetch("/app/units/save-report", {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: { "Content-Type": "application/json", "X-CSRF-Token": meta ? meta.content : "" },
          body: JSON.stringify({ outcome: outcome, ms: Date.now() - t0, edit: edit, photos: kept() })
        }).catch(function () {});
      } catch (x) { /* reporting must never break a save */ }
    };
    // The same form comes back with the reason (a warning, a missing field, "looks like a duplicate"). The page's own form stays
    // as it is, with its photos and its listeners: only the message, the review and the Save row are taken from the answer.
    var showRefusal = function (fresh) {
      busy = false;
      lock(false);
      resetButton(sub);
      var oldBanner = form.querySelector(":scope > .notice.bad");
      if (oldBanner) oldBanner.remove();
      var newBanner = fresh.querySelector(":scope > .notice.bad");
      if (newBanner) form.insertBefore(document.importNode(newBanner, true), form.firstChild.nextSibling);
      var nr = fresh.querySelector("[data-auto-review]"), orv = form.querySelector("[data-auto-review]");
      if (nr && orv) orv.innerHTML = nr.innerHTML;
      var ns = fresh.querySelector("[data-save-row]"), os = form.querySelector("[data-save-row]");
      if (ns && os) os.innerHTML = ns.innerHTML;
      // Show every step, then let the page's own check decide whether Save is open (the warnings tick).
      form.dispatchEvent(new CustomEvent("stepgoto", { detail: 99 }));
      if (orv) orv.dispatchEvent(new CustomEvent("htmx:afterSwap", { bubbles: true }));
      var alertBox = form.querySelector("[role=alert]");
      if (alertBox && alertBox.scrollIntoView) alertBox.scrollIntoView({ block: "center" });
    };
    // Before any photo is uploaded the server checks the form (missing fields, a look-alike unit): a refusal costs no upload at all.
    var precheckStep = function () {
      if (!chosen().some(function (x) { return !x.key && uploading(x); })) return Promise.resolve();
      return new Promise(function (ok, no) {
        var fd = new FormData(form);
        fd.delete("photos");
        fd.append("check_only", "1");
        if (sub && sub.name) fd.append(sub.name, sub.value);
        var px = new XMLHttpRequest();
        px.open("POST", action, true);
        px.setRequestHeader("Accept", "text/html");
        px.onerror = function () { ok(); }; // no network answer: the save itself reports it
        px.onload = function () {
          var j = null;
          try { j = JSON.parse(px.responseText); } catch (x) { j = null; }
          if (px.status === 200 && j && j.ok) return ok();
          var fresh = new DOMParser().parseFromString(px.responseText, "text/html").getElementById("unit-form");
          if (!fresh) return ok(); // an error page: go on, the real save answers
          clearTimers();
          report("refused");
          showRefusal(fresh);
          no({ stop: true });
        };
        px.send(fd);
      });
    };
    lock(true);
    progress(sub, 0);
    var tick = setInterval(function () {
      // The last part (the server working) moves slowly toward 99 so the bar never sits still while it is alive.
      if (serverFrom) {
        var secs = (Date.now() - serverFrom) / 1000;
        pct = 80 + 19 * (1 - Math.exp(-secs / 20));
        progress(sub, pct);
        status(form, fill(T.server, { s: Math.round(secs) }));
      }
    }, 500);
    timers.push(tick);
    // 0-50%: photos still on their way to storage; 50-60%: any photo that goes with the form is reduced; 60-80%: the form goes
    // up; 80-99%: the server saves. Most of the time the photos are already in storage and the first part is instant.
    var upT0 = 0;
    precheckStep().then(function () { return settle(function (frac, done, total) {
      pct = 50 * frac;
      progress(sub, pct);
      var msg = total && done < total ? fill(T.prep, { i: Math.min(done + 1, total), n: total }) : "";
      if (msg) {
        // A slow connection is said out loud: by the measured pace (over 40 s left after a few seconds) or the browser's own 2G/3G hint.
        var now = Date.now();
        if (!upT0) upT0 = now;
        var spent = (now - upT0) / 1000, eta = frac > 0.02 ? spent * (1 - frac) / frac : 0;
        var weak = navigator.connection && /(^|-)2g$|3g/.test(navigator.connection.effectiveType || "");
        if (spent > 4 && eta > 40) msg = fill(T.slow, { m: Math.max(1, Math.round(eta / 60)) });
        else if (weak && total > 3) msg = T.slow0;
      }
      status(form, msg);
    }); }).then(function () {
      return prepare(form, function (done, total) {
        pct = 50 + 10 * (total ? done / total : 1);
        progress(sub, pct);
      });
    }).then(function () {
      pct = 60;
      progress(sub, pct);
      status(form, T.sending);
      var fd = new FormData(form);
      if (sub && sub.name) fd.append(sub.name, sub.value);
      xhr = new XMLHttpRequest();
      xhr.open("POST", action, true);
      xhr.setRequestHeader("Accept", "text/html");
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        pct = 60 + 20 * (ev.loaded / ev.total);
        progress(sub, pct);
      };
      xhr.upload.onload = function () { serverFrom = Date.now(); };
      xhr.onerror = function () {
        // The connection dropped: the save may still have gone through, so ask before saying it failed.
        checkSaved().then(function (saved) { if (!saved) { report("network"); failed(T.notSaved); } });
      };
      xhr.onload = function () {
        clearTimers();
        report(xhr.status >= 400 ? "refused" : "ok");
        if (xhr.responseURL && xhr.responseURL !== new URL(action, location.href).href && xhr.status < 400) { progress(sub, 100); clearPersist(); window.__whSaved = true; location.assign(xhr.responseURL); return; }
        var fresh = new DOMParser().parseFromString(xhr.responseText, "text/html").getElementById("unit-form");
        // No form back (a server error page): ask whether it saved before saying it did not.
        if (!fresh) { checkSaved().then(function (saved) { if (!saved) failed(T.notSaved); }); return; }
        // The same form comes back with the reason (a warning, a missing field, "looks like a duplicate"). The page's own form stays
        // as it is, with its photos and its listeners: only the message, the review and the Save row are taken from the answer.
        showRefusal(fresh);
      };
      xhr.send(fd);
      // 60 seconds with no answer: ask whether it was saved; if not, stop waiting and show the error with Try again.
      timers.push(setTimeout(function () {
        checkSaved().then(function (saved) {
          if (saved) return;
          report("timeout");
          try { xhr.abort(); } catch (x) { /* already done */ }
          failed(T.notSaved);
        });
      }, CHECK_AFTER_MS));
    }).catch(function (err) {
      if (err && err.stop) return;
      failed(T.notSaved);
    });
  });

  // The form's tray starts with the page, so photos uploaded before a reload come back at once.
  var first = document.getElementById("unit-form");
  if (first && first.querySelector("[data-photo-preview]")) { start(first); restore(); }

  // Closing the page while photos are still going up would lose them.
  window.addEventListener("beforeunload", function (e) {
    if (!window.__whSaved && tray && chosen().some(uploading)) { e.preventDefault(); e.returnValue = ""; }
  });
})();
