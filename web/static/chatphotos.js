// web/static/chatphotos.js — "Match photos" page (/app/import, third tab). Everything happens in the browser: the zip is
// read here, the chat text is matched here (ChatMatch), photos are shrunk here and sent one at a time. The server
// only sees the photos (and, with no unit codes, the text of the posts that look like units).
(function () {
  "use strict";
  var root = document.querySelector("[data-cp]");
  if (!root || !window.ZipRead || !window.ChatMatch) return;

  var lang = root.getAttribute("data-lang") === "en" ? "en" : "ar";
  var TEXT = {
    ar: {
      pick: "اختار ملف الـ zip الأول.", reading: "جاري قراءة الملف…", noChat: "مفيش ملف الشات (.txt) جوه الـ zip.", badZip: "الملف مش zip سليم.", encrypted: "الملف عليه باسورد.",
      noUnits: "مفيش وحدات في الشركة لسه. استورد الشيت الأول أو اختار «اقرأ الوحدات من البوستات».", big: "الملف كبير والتليفون ممكن يقف. الأفضل تستخدم كمبيوتر.",
      photos: "صورة", units: "وحدة", noPhotos: "وحدات من غير صور", tray: "صور مش متوزعة", unknown: "أكواد في الشات مش موجودة", pattern: "ترتيب الشات", p_photos_first: "الصور الأول وبعدها الوصف", p_text_first: "الوصف الأول وبعدها الصور", p_mixed: "مختلط (مفيش قاعدة واحدة)", p_unknown: "مش واضح",
      reason_orphan: "مفيش وصف جنبها", reason_ambiguous: "بين وحدتين: اختار", reason_against_pattern: "عكس ترتيب الشات: اختار", reason_multi_code: "الرسالة فيها أكتر من كود: اختار", assign: "اكتب الكود", assigned: "اتوزعت على", skip: "سيبها",
      overCap: "زيادة عن الحد (بتتساب)", existing: "فيها صور بالفعل", missing: "مش موجودة في الملف", use: "استخدم", omitted: "صور متحملتش في التصدير", skippedMedia: "فيديو أو ملفات اتتخطت", duplicates: "بوستات مكررة",
      addNew: "ضيف الصور الجديدة بس", skipHave: "سيب الوحدات اللي فيها صور", apply: "ابدأ التحميل", cancel: "إلغاء", keepOpen: "سيب الصفحة مفتوحة والشاشة منورة لحد ما يخلص.",
      stageShrink: "تصغير وتحميل الصور", of: "من", left: "دقيقة متبقية تقريباً", done: "خلص", uploaded: "اتحملت", dup: "مكررة (موجودة)", full: "الوحدة اكتملت 15 صورة", unreadable: "مش قابلة للقراءة", failed: "فشلت", cancelled: "اتلغى",
      seeUnits: "افتح الوحدات", seeReview: "افتح المراجعة", nothing: "مفيش صور لتحميلها.", noPosts: "ملقيناش بوستات فيها وحدات.", cap: "بنقرا لحد 40 بوست في المرة. غيّر التاريخ للباقي.", post: "بوست", tooMany: "اتجاوزت الحد", rateWait: "بنستنى شوية…", startFail: "مقدرناش نبدأ الاستيراد. جرب تاني.",
      verify: "راجع الصور", swap: "بدّل الصور مع الوحدة اللي بعدها", full15: "الوحدة وصلت 15 صورة. شيل علامة صورة تانية أو شيل صورة قديمة.", oldPhotos: "صور الوحدة الحالية: علّم اللي تتشال", removeFail: "مقدرناش نشيل الصور القديمة", heicFail: "صور HEIC متحولتش", converted: "صور اتحولت من HEIC", aiOff: "الذكاء الاصطناعي مش متاح: القراءة بالقواعد بس.", errors: "أخطاء", planFail: "مقدرناش نقرا البوستات. جرب تاني."
    },
    en: {
      pick: "Choose the zip file first.", reading: "Reading the file…", noChat: "No chat text (.txt) inside the zip.", badZip: "That is not a readable zip.", encrypted: "The zip is password-protected.",
      noUnits: "There are no units in the agency yet. Import the sheet first or choose “Read units from the posts”.", big: "This file is big and a phone may stop. A computer is better.",
      photos: "photos", units: "units", noPhotos: "Units with no photos", tray: "Photos not placed", unknown: "Codes in the chat that are not in the app", pattern: "Chat order", p_photos_first: "photos first, then the description", p_text_first: "description first, then photos", p_mixed: "mixed (no single rule)", p_unknown: "not clear",
      reason_orphan: "no description next to it", reason_ambiguous: "between two units: choose", reason_against_pattern: "against the chat order: choose", reason_multi_code: "the message has several codes: choose", assign: "Type the code", assigned: "placed on", skip: "Leave out",
      overCap: "over the limit (left out)", existing: "already has photos", missing: "missing from the file", use: "Use", omitted: "photos not included in the export", skippedMedia: "videos or files skipped", duplicates: "duplicate posts",
      addNew: "Add new photos only", skipHave: "Skip units that already have photos", apply: "Start upload", cancel: "Cancel", keepOpen: "Keep this page open and the screen on until it finishes.",
      stageShrink: "Shrinking and uploading photos", of: "of", left: "min left (about)", done: "Done", uploaded: "uploaded", dup: "duplicates (already there)", full: "unit already has 15 photos", unreadable: "unreadable", failed: "failed", cancelled: "Cancelled",
      seeUnits: "Open units", seeReview: "Open the review", nothing: "No photos to upload.", noPosts: "No posts describing a unit were found.", cap: "Up to 40 posts at a time. Change the date for the rest.", post: "Post", tooMany: "over the limit", rateWait: "Waiting a moment…", startFail: "Could not start the import. Try again.",
      verify: "Verify photos", swap: "Swap photos with the next unit", full15: "The unit is at 15 photos. Untick another photo or remove an old one.", oldPhotos: "The unit's current photos: tick the ones to remove", removeFail: "Could not remove the old photos", heicFail: "HEIC photos that could not be converted", converted: "photos converted from HEIC", aiOff: "AI is not available: read with the rules only.", errors: "Errors", planFail: "Could not read the posts. Try again."
    }
  }[lang];

  var csrf = root.getAttribute("data-csrf") || "";
  var out = root.querySelector("[data-cp-out]");
  var $ = function (name) { return root.querySelector("[data-cp-" + name + "]"); };
  var state = null;
  var run = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "on") Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var say = function (msg, bad) { out.textContent = ""; out.appendChild(el("p", { class: "card notice" + (bad ? " bad" : ""), role: "status", text: msg })); };
  var base = function (p) { return String(p).split("/").pop(); };
  var MAXP = 15;

  // Every step is timed and sent to the server log (time, ok, error), so slow or failing steps can be found.
  var steps = [];
  async function timed(name, fn, meta) {
    var t0 = Date.now();
    try {
      var r = await fn();
      steps.push({ step: name, ms: Date.now() - t0, ok: true, meta: meta || null });
      return r;
    } catch (e) {
      steps.push({ step: name, ms: Date.now() - t0, ok: false, error: (e && (e.code || e.message)) || "failed", meta: meta || null });
      throw e;
    }
  }
  function flush() {
    if (!steps.length) return;
    var batch = steps.splice(0);
    fetch(root.getAttribute("data-log-url"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ steps: batch }) }).catch(function () {});
  }

  // ---- reading the file ----------------------------------------------------------------------------------------
  async function load() {
    var file = $("file").files && $("file").files[0];
    if (!file) return say(TEXT.pick, true);
    say(TEXT.reading);
    var zip = null;
    var text;
    try {
      if (/\.txt$/i.test(file.name)) {
        text = await file.text();
      } else {
        zip = await timed("read_zip", function () { return ZipRead.open(file); }, { mb: Math.round(file.size / 1048576) });
        var txts = zip.entries.filter(function (e) { return /\.txt$/i.test(e.name) && e.size <= 40 * 1024 * 1024; })
          .sort(function (a, b) { return Number(/chat/i.test(base(b.name))) - Number(/chat/i.test(base(a.name))); });
        if (!txts.length) return say(TEXT.noChat, true);
        text = await timed("read_chat", function () { return zip.text(txts[0]); });
      }
    } catch (err) {
      flush();
      return say(err && err.code === "ENCRYPTED" ? TEXT.encrypted : TEXT.badZip, true);
    }
    var byName = {};
    var byLower = {};
    if (zip) zip.entries.forEach(function (e) { byName[base(e.name)] = e; byLower[base(e.name).toLowerCase()] = e; });
    var mode = $("mode").value;
    var units = null;
    if (mode === "codes") {
      var r = await fetch(root.getAttribute("data-units-url"), { credentials: "same-origin" });
      units = r.ok ? (await r.json()).units : [];
      if (!units.length) return say(TEXT.noUnits, true);
    }
    state = { file: file, zip: zip, text: text, byName: byName, byLower: byLower, mode: mode, units: units, aliases: {}, assigned: {}, pick: {}, files: {}, drops: {}, olds: {}, skipped: {} };
    if (file.size > 1024 * 1024 * 1024 && /Mobi|Android|iPhone/i.test(navigator.userAgent)) state.bigWarn = true;
    compute();
  }

  var entryOf = function (name) { return state.byName[name] || state.byLower[String(name).toLowerCase()] || null; };

  function compute() {
    var codes = state.units ? state.units.map(function (u) { return u.code; }) : null;
    var t0 = Date.now();
    state.res = ChatMatch.match(state.text, {
      since: $("since").value || null, windowMin: Number($("window").value) || 10, sameSender: $("same").checked, pattern: $("pattern").value, codes: codes, aliases: state.aliases
    });
    state.files = {};
    steps.push({ step: "match", ms: Date.now() - t0, ok: true, meta: { messages: state.res.stats.messages, photos: state.res.stats.photos, dividers: state.res.stats.dividers || 0, tray: state.res.tray.length } });
    flush();
    render();
  }

  // ---- showing the result ----------------------------------------------------------------------------------------
  // Which photos are ticked: the person's choice, else the first ones that fit (a unit holds 15).
  var pickOf = function (ref, k, slots) { return state.pick[ref.name] === undefined ? k < slots : state.pick[ref.name]; };
  function thumbs(refs, limit, slots) {
    var box = el("div", { class: "row thumbs" });
    var room = slots === undefined ? MAXP : slots;
    refs.slice(0, limit || refs.length).forEach(function (ref, k) {
      var entry = state.zip ? entryOf(ref.name) : null;
      var cell = el("label", { class: "thumb" });
      var box1 = el("input", { type: "checkbox", checked: Boolean(entry) && pickOf(ref, k, room), disabled: !entry, on: { change: function (ev) {
        var on = refs.filter(function (r, i) { return r.name !== ref.name && entryOf(r.name) && pickOf(r, i, room); }).length;
        if (ev.target.checked && on >= room) { ev.target.checked = false; say(TEXT.full15, true); return; }
        state.pick[ref.name] = ev.target.checked;
      } } });
      cell.appendChild(box1);
      if (!entry) cell.appendChild(el("span", { class: "muted", text: TEXT.missing }));
      else {
        var img = el("img", { alt: "", width: "64", height: "64", loading: "lazy" });
        state.zip.blob(entry).then(function (b) { return previewOf(b, ref.name); }).then(function (b) { img.src = URL.createObjectURL(b); img.onload = function () { URL.revokeObjectURL(img.src); }; }).catch(function () {});
        cell.appendChild(img);
      }
      box.appendChild(cell);
    });
    return box;
  }
  function lazy(summary, refs, slots) {
    var d = el("details", {}, [el("summary", { text: summary })]);
    var filled = false;
    d.addEventListener("toggle", function () { if (d.open && !filled) { filled = true; d.appendChild(thumbs(refs, 0, slots)); } });
    return d;
  }
  var isHeic = function (name) { return /\.(heic|heif)$/i.test(String(name)); };
  // The preview of a HEIC photo needs the converter too; a browser that reads it natively shows it as it is.
  async function previewOf(blob, name) { return isHeic(name) ? (await toJpeg(blob, name)) : blob; }

  var idOf = function (x) { return state.res.mode === "codes" ? x.code : String(x.i); };
  var filesOf = function (x) { return state.files[idOf(x)] || x.files; };
  var dropCount = function (id) { var d = state.drops[id] || {}; return Object.keys(d).filter(function (k) { return d[k]; }).length; };
  // The matcher was unsure about this unit's photos: the person swaps them with the next unit's in one click.
  function swapWithNext(list, k) {
    var a = list[k];
    var b = list[k + 1];
    var fa = filesOf(a);
    state.files[idOf(a)] = filesOf(b);
    state.files[idOf(b)] = fa;
    render();
  }
  // The unit's current photos (loaded when opened): tick the ones to remove to make room for new ones.
  function oldPhotos(code) {
    var d = el("details", {}, [el("summary", { text: TEXT.oldPhotos })]);
    var filled = false;
    d.addEventListener("toggle", function () {
      if (!d.open || filled) return;
      filled = true;
      fetch(root.getAttribute("data-unit-photos-url").replace("{code}", encodeURIComponent(code)), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : { photos: [] }; })
        .then(function (j) {
          var box = el("div", { class: "row thumbs" });
          (j.photos || []).forEach(function (ph) {
            var on = Boolean((state.drops[code] || {})[ph.id]);
            var cb = el("input", { type: "checkbox", checked: on, on: { change: function (ev) { state.drops[code] = state.drops[code] || {}; state.drops[code][ph.id] = ev.target.checked; render(); } } });
            box.appendChild(el("label", { class: "thumb" }, [cb, el("img", { src: ph.url, alt: "", width: "64", height: "64", loading: "lazy" })]));
          });
          d.appendChild(box);
        })
        .catch(function () {});
    });
    return d;
  }

  function render() {
    var r = state.res;
    out.textContent = "";
    if (state.bigWarn) out.appendChild(el("p", { class: "card notice", text: TEXT.big }));
    var totalPhotos = 0;
    var list = entries();
    list.forEach(function (x) { totalPhotos += x.files.length; });
    out.appendChild(el("p", { class: "card", "data-cp-summary": true, text: list.length + " " + TEXT.units + " · " + totalPhotos + " " + TEXT.photos + " · " + TEXT.pattern + ": " + TEXT["p_" + r.pattern] + (r.stats.omittedMedia ? " · " + r.stats.omittedMedia + " " + TEXT.omitted : "") + (r.stats.skippedMedia ? " · " + r.stats.skippedMedia + " " + TEXT.skippedMedia : "") + (r.stats.duplicates ? " · " + r.stats.duplicates + " " + TEXT.duplicates : "") }));
    if (r.stats.truncated) out.appendChild(el("p", { class: "muted", text: TEXT.cap }));

    var existing = {};
    (state.units || []).forEach(function (u) { existing[u.code] = u.photos; });
    var ol = el("ol", { class: "results", "data-cp-list": true });
    list.forEach(function (x, k) {
      var id = r.mode === "codes" ? x.code : String(x.i);
      var refs = filesOf(x).concat(assignedTo(id));
      var slots = Math.max(0, MAXP - (existing[id] || 0) + dropCount(id));
      var title = r.mode === "codes" ? x.code : TEXT.post + " " + (k + 1) + " · " + (x.sender || "") + " · " + x.text.slice(0, 70);
      var head = el("div", { class: "row" }, [
        el("input", { type: "checkbox", "data-cp-pick": id, checked: !state.skipped[id], on: { change: function (ev) { state.skipped[id] = !ev.target.checked; } } }),
        el("strong", { text: title }),
        el("span", { class: "muted", text: refs.length + " " + TEXT.photos + (existing[id] ? " · " + TEXT.existing + " (" + existing[id] + ")" : "") + (x.over ? " · " + x.over + " " + TEXT.overCap : "") + (refs.length > slots ? " · " + slots + " / " + MAXP : "") }),
        x.verify ? el("span", { class: "warn", "data-cp-verify": id, text: "⚠️ " + TEXT.verify }) : null,
        x.verify && list[k + 1] ? el("button", { type: "button", class: "secondary", "data-cp-swap": id, text: "⇄ " + TEXT.swap, on: { click: function () { swapWithNext(list, k); } } }) : null
      ]);
      ol.appendChild(el("li", { class: "card", "data-cp-unit": id }, [head, refs.length ? lazy(refs.length + " " + TEXT.photos, refs, slots) : null, r.mode === "codes" && existing[id] ? oldPhotos(id) : null]));
    });
    out.appendChild(ol);

    if (r.tray.length) {
      out.appendChild(el("h3", { text: TEXT.tray + " (" + r.tray.length + ")" }));
      var tray = el("div", { "data-cp-tray": true });
      r.tray.forEach(function (g) {
        var row = el("div", { class: "card stack", "data-cp-group": g.id }, [el("p", { class: "muted", text: g.files.length + " " + TEXT.photos + " · " + (g.sender || "") + " · " + (g.at || "") + " · " + TEXT["reason_" + g.reason] }), thumbs(g.files, 6)]);
        row.appendChild(assignControl(g));
        tray.appendChild(row);
      });
      out.appendChild(tray);
    }
    if (r.unknownCodes && r.unknownCodes.length) {
      out.appendChild(el("h3", { text: TEXT.unknown + " (" + r.unknownCodes.length + ")" }));
      var ul = el("ul", { "data-cp-unknown": true });
      r.unknownCodes.forEach(function (u) {
        var li = el("li", {}, [el("code", { text: u.token })]);
        u.suggestions.forEach(function (s) {
          li.appendChild(el("button", { type: "button", class: "secondary", text: TEXT.use + " " + s, on: { click: function () { state.aliases[ChatMatch.normCode(u.token)] = s; compute(); } } }));
        });
        ul.appendChild(li);
      });
      out.appendChild(ul);
    }
    if (r.noPhotos && r.noPhotos.length) {
      var d = el("details", {}, [el("summary", { text: TEXT.noPhotos + " (" + r.noPhotos.length + ")" })]);
      d.appendChild(el("p", { class: "muted", text: r.noPhotos.slice(0, 300).join("، ") + (r.noPhotos.length > 300 ? " …" : "") }));
      out.appendChild(d);
    }
    if (r.mode === "codes") {
      var sel = el("select", { "data-cp-have": true }, [el("option", { value: "add", text: TEXT.addNew }), el("option", { value: "skip", text: TEXT.skipHave })]);
      out.appendChild(el("label", {}, [sel]));
    }
    out.appendChild(el("button", { type: "button", "data-cp-apply": true, text: TEXT.apply, on: { click: apply } }));
  }

  // The units (or posts) shown and sent: the matched ones, plus units that only got photos placed by hand.
  function entries() {
    var r = state.res;
    if (r.mode !== "codes") return r.posts;
    var have = {};
    r.units.forEach(function (u) { have[u.code] = true; });
    var extra = [];
    Object.keys(state.assigned).forEach(function (gid) {
      var code = state.assigned[gid].id;
      if (!have[code]) { have[code] = true; extra.push({ code: code, files: [], messages: 0, over: 0 }); }
    });
    return r.units.concat(extra);
  }

  // A tray group is placed by typing a code (codes mode) or choosing a post (posts mode); the choice sticks by file name.
  function assignedTo(id) {
    var refs = [];
    Object.keys(state.assigned).forEach(function (gid) {
      if (state.assigned[gid].id !== id) return;
      var g = state.res.tray.filter(function (t) { return t.id === gid; })[0];
      if (g) refs = refs.concat(g.files);
    });
    return refs;
  }
  function assignControl(g) {
    var wrap = el("div", { class: "row" });
    var done = function (id) {
      if (id) state.assigned[g.id] = { id: id };
      else delete state.assigned[g.id];
      render();
    };
    if (state.res.mode === "codes") {
      var listId = "cp-codes";
      if (!document.getElementById(listId)) {
        var dl = el("datalist", { id: listId });
        state.units.slice(0, 5000).forEach(function (u) { dl.appendChild(el("option", { value: u.code })); });
        root.appendChild(dl);
      }
      var input = el("input", { type: "text", list: listId, placeholder: TEXT.assign, "data-cp-code": g.id });
      input.addEventListener("change", function () {
        var v = ChatMatch.normCode(input.value);
        var hit = state.units.filter(function (u) { return ChatMatch.normCode(u.code) === v; })[0];
        if (hit) done(hit.code);
      });
      wrap.appendChild(input);
    } else {
      var select = el("select", { "data-cp-post": g.id }, [el("option", { value: "", text: TEXT.skip })]);
      state.res.posts.forEach(function (p, k) { select.appendChild(el("option", { value: String(p.i), text: TEXT.post + " " + (k + 1) + ": " + p.text.slice(0, 40) })); });
      select.addEventListener("change", function () { done(select.value || null); });
      wrap.appendChild(select);
    }
    var a = state.assigned[g.id];
    if (a) wrap.appendChild(el("span", { class: "muted", text: TEXT.assigned + " " + a.id }));
    return wrap;
  }

  // ---- shrinking and sending ----------------------------------------------------------------------------------
  // HEIC/HEIF (an iPhone photo sent as it is): read natively where the browser can, else converted to JPEG here.
  function loadHeic() {
    return new Promise(function (resolve, reject) {
      if (window.heic2any) return resolve(window.heic2any);
      var tag = document.createElement("script");
      tag.src = root.getAttribute("data-heic-url");
      tag.onload = function () { resolve(window.heic2any); };
      tag.onerror = function () { reject(new Error("heic_lib")); };
      document.head.appendChild(tag);
    });
  }
  async function toJpeg(blob) {
    var heic = await loadHeic();
    var out = await heic({ blob: blob, toType: "image/jpeg", quality: 0.82 });
    return Array.isArray(out) ? out[0] : out;
  }
  async function shrink(blob, name) {
    var bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (err) {
      if (!isHeic(name)) throw err;
      bmp = await createImageBitmap(await toJpeg(blob));
      if (run) run.converted++;
    }
    var s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * s));
    canvas.height = Math.max(1, Math.round(bmp.height * s));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    var jpeg = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.82); });
    canvas.width = canvas.height = 0;
    if (!jpeg) throw new Error("encode");
    return jpeg;
  }

  async function send(url, blob) {
    for (var attempt = 0; attempt < 8; attempt++) {
      if (run.cancelled) return { cancelled: true };
      try {
        var fd = new FormData();
        fd.append("_csrf", csrf);
        fd.append("photo", blob, "photo.jpg");
        var r = await fetch(url, { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": csrf } });
        if (r.status === 429) {
          var j = await r.json().catch(function () { return {}; });
          run.note = TEXT.rateWait;
          await sleep(Math.min(60, j.retry_after || 30) * 1000);
          continue;
        }
        if (r.status >= 500) { await sleep(1000 * Math.pow(2, Math.min(attempt, 4))); continue; }
        var body = await r.json().catch(function () { return {}; });
        return { status: r.status, body: body };
      } catch (err) {
        await sleep(1000 * Math.pow(2, Math.min(attempt, 4)));
      }
    }
    return { failed: true };
  }

  // The work list: [{ ref, url }] in order; codes mode posts straight to the unit, posts mode to the import's post.
  function plan() {
    var r = state.res;
    var have = $("have") ? $("have").value : "add";
    var tasks = [];
    var gone = 0;
    var picks = {};
    if (r.mode === "codes") entries().forEach(function (u) { picks[u.code] = filesOf(u); });
    else r.posts.forEach(function (p) { picks[String(p.i)] = filesOf(p); });
    Object.keys(picks).forEach(function (id) {
      if (state.skipped[id]) return;
      var existing = r.mode === "codes" ? (state.units.filter(function (u) { return u.code === id; })[0] || {}).photos || 0 : 0;
      if (existing && have === "skip") return;
      var seen = {};
      var slots = Math.max(0, MAXP - existing + dropCount(id));
      var refs = picks[id].concat(assignedTo(id)).filter(function (x) { if (seen[x.name]) return false; seen[x.name] = true; return true; });
      refs = refs.filter(function (x, k) { return pickOf(x, k, slots); }).slice(0, slots);
      refs.forEach(function (ref) {
        var entry = state.zip ? entryOf(ref.name) : null;
        if (!entry) gone++;
        else tasks.push({ id: id, ref: ref, entry: entry });
      });
    });
    return { tasks: tasks, gone: gone };
  }

  async function apply() {
    var p = plan();
    var postsMode = state.res.mode === "posts";
    if (!p.tasks.length && !(postsMode && state.res.posts.some(function (x) { return !state.skipped[String(x.i)]; }))) return say(TEXT.nothing, true);
    var importId = null;
    var aiNote = null;
    if (postsMode) {
      var chosen = state.res.posts.filter(function (x) { return !state.skipped[String(x.i)]; });
      var j0 = null;
      try {
        j0 = await timed("plan", async function () {
          var r0 = await fetch(root.getAttribute("data-plan-url"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ filename: state.file.name, posts: chosen.map(function (x) { return { sender: x.sender, at: x.at, text: x.text }; }) }) });
          var j = await r0.json().catch(function () { return {}; });
          if (!r0.ok || !j.id) { var e = new Error(j.message || (r0.status === 422 ? TEXT.noPosts : TEXT.planFail)); e.code = j.error || "http_" + r0.status; throw e; }
          return j;
        }, { posts: chosen.length });
      } catch (err) {
        flush();
        return say(err.message || TEXT.planFail, true);
      }
      importId = j0.id;
      aiNote = j0.message || null;
      var index = {};
      chosen.forEach(function (x, k) { index[String(x.i)] = k; });
      p.tasks = p.tasks.filter(function (t) { return index[t.id] !== undefined; }).map(function (t) { t.url = root.getAttribute("data-plan-photo-url").replace("{id}", importId).replace("{row}", index[t.id] + 1); return t; });
    } else {
      p.tasks.forEach(function (t) { t.url = root.getAttribute("data-unit-url").replace("{code}", encodeURIComponent(t.id)); });
      var dropFail = 0;
      var codesToClean = Object.keys(state.drops).filter(function (c) { return dropCount(c) && !state.skipped[c]; });
      if (codesToClean.length) {
        await timed("remove_old", async function () {
          for (var q = 0; q < codesToClean.length; q++) {
            var code = codesToClean[q];
            var ids = Object.keys(state.drops[code]).filter(function (k) { return state.drops[code][k]; });
            var rr = await fetch(root.getAttribute("data-unit-remove-url").replace("{code}", encodeURIComponent(code)), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ ids: ids }) }).catch(function () { return { ok: false }; });
            if (!rr.ok) dropFail++;
          }
        }, { units: codesToClean.length });
      }
    }
    run = { cancelled: false, done: 0, total: p.tasks.length, started: Date.now(), counts: { ok: 0, dup: 0, full: 0, unreadable: 0, failed: 0, heic: 0, missing: p.gone }, converted: 0, errors: {}, aiNote: aiNote, dropFail: typeof dropFail === "number" ? dropFail : 0, note: "" };
    var wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch (err) { wake = null; }
    out.textContent = "";
    var bar = el("progress", { max: String(run.total), value: "0", "data-cp-progress": true });
    var line = el("p", { "data-cp-progress-text": true });
    var cancel = el("button", { type: "button", class: "secondary", text: TEXT.cancel, on: { click: function () { run.cancelled = true; } } });
    out.appendChild(el("div", { class: "card stack" }, [el("strong", { text: TEXT.stageShrink }), bar, line, el("p", { class: "muted", text: TEXT.keepOpen }), cancel]));
    var tick = function () {
      bar.value = run.done;
      var eta = run.done >= 3 ? Math.ceil((((Date.now() - run.started) / run.done) * (run.total - run.done)) / 60000) : null;
      line.textContent = run.done + " " + TEXT.of + " " + run.total + (eta !== null ? " · ~" + eta + " " + TEXT.left : "") + (run.note ? " · " + run.note : "");
      run.note = "";
    };
    var queue = p.tasks.slice();
    var byGroup = {};
    queue.forEach(function (t) { (byGroup[t.id] = byGroup[t.id] || []).push(t); });
    var groups = Object.keys(byGroup);
    // Photos of one unit/post go one after the other (their order stays); different units go side by side.
    var worker = async function () {
      while (!run.cancelled && groups.length) {
        var g = byGroup[groups.shift()];
        for (var i = 0; i < g.length && !run.cancelled; i++) {
          var t = g[i];
          var res;
          try {
            var small = await shrink(await state.zip.blob(t.entry), t.ref.name);
            res = await send(t.url, small);
          } catch (err) {
            res = { unreadable: true, heic: isHeic(t.ref.name) };
          }
          var b = res.body || {};
          if (res.cancelled) break;
          if (res.status >= 400 && !b.full && !b.dup && res.status !== 422) run.errors[b.message || b.error || "http_" + res.status] = true;
          if (res.heic) run.counts.heic++;
          else if (res.unreadable || res.status === 422) run.counts.unreadable++;
          else if (res.failed || (res.status && res.status >= 400 && !b.full && !b.dup)) run.counts.failed++;
          else if (b.dup) run.counts.dup++;
          else if (b.full) run.counts.full++;
          else run.counts.ok++;
          run.done++;
          tick();
        }
      }
    };
    tick();
    await Promise.all([worker(), worker(), worker()]);
    if (wake && wake.release) wake.release().catch(function () {});
    finish(importId);
  }

  function finish(importId) {
    var c = run.counts;
    out.textContent = "";
    var parts = [[c.ok, TEXT.uploaded], [c.dup, TEXT.dup], [c.full, TEXT.full], [c.unreadable, TEXT.unreadable], [c.missing, TEXT.missing], [c.failed, TEXT.failed]].filter(function (x) { return x[0]; }).map(function (x) { return x[0] + " " + x[1]; });
    if (c.heic) parts.push(c.heic + " " + TEXT.heicFail);
    if (run.converted) parts.push(run.converted + " " + TEXT.converted);
    out.appendChild(el("p", { class: "card notice", role: "status", "data-cp-done": true, text: (run.cancelled ? TEXT.cancelled : TEXT.done) + ": " + parts.join(" · ") }));
    var errs = Object.keys(run.errors || {});
    if (run.dropFail) errs.push(TEXT.removeFail);
    if (errs.length) out.appendChild(el("p", { class: "card notice bad", role: "alert", "data-cp-errors": true, text: TEXT.errors + ": " + errs.join(" · ") }));
    if (run.aiNote) out.appendChild(el("p", { class: "card notice", role: "status", text: TEXT.aiOff + " " + run.aiNote }));
    steps.push({ step: "upload", ms: Date.now() - run.started, ok: !(c.failed || errs.length), meta: { ok: c.ok, dup: c.dup, failed: c.failed, unreadable: c.unreadable, heic: c.heic, converted: run.converted, total: run.total } });
    flush();
    if (importId) out.appendChild(el("a", { class: "btn", href: "/app/import/" + importId, text: TEXT.seeReview }));
    else out.appendChild(el("a", { class: "btn", href: "/app/units", text: TEXT.seeUnits }));
    // Anything that went wrong stays on screen; a clean run goes straight to the review.
    if (importId && !run.cancelled && !errs.length && !c.failed && !c.heic) window.location.href = "/app/import/" + importId;
  }

  // The Read button is locked and shows a spinner until the unit list and the reading are done.
  $("read").addEventListener("click", function () {
    var b = this;
    b.classList.add("busy");
    b.disabled = true;
    Promise.resolve(load()).finally(function () { b.classList.remove("busy"); b.disabled = false; });
  });
  ["window", "pattern", "same", "since"].forEach(function (n) { $(n).addEventListener("change", function () { if (state) compute(); }); });
})();
