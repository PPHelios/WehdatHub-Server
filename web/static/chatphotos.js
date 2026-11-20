// web/static/chatphotos.js — "Match photos" page (/app/import, third tab). Everything happens in the browser: the zip is
// read here, the chat text is matched here (ChatMatch), photos are shrunk here and sent one at a time. The server
// only sees the photos (and, with no unit codes, the text of the posts that look like units).
(function () {
  "use strict";
  if (!window.ZipRead || !window.ChatMatch) return;
  // One instance per [data-cp] box: the WhatsApp import tab (posts, data-cp-mode=posts) and the photos-by-code tab.
  Array.prototype.forEach.call(document.querySelectorAll("[data-cp]"), function (root) {

  var lang = root.getAttribute("data-lang") === "en" ? "en" : "ar";
  var TEXT = {
    ar: {
      lastImport: "آخر تحميل للشات ده:", sinceLast: "من آخر تحميل",
      pick: "اختار ملف الـ zip الأول.", reading: "جاري قراءة الملف…", noChat: "مفيش ملف الشات (.txt) جوه الـ zip.", badZip: "الملف مش zip سليم.", encrypted: "الملف عليه باسورد.",
      noUnits: "مفيش وحدات في الشركة لسه. حمّل الشيت الأول أو اختار «اقرأ الوحدات من البوستات».", big: "الملف كبير والتليفون ممكن يقف. الأفضل تستخدم كمبيوتر.",
      photos: "صورة", units: "وحدة", noPhotos: "وحدات من غير صور", tray: "صور مش متوزعة", unknown: "أكواد في الشات مش موجودة", pattern: "ترتيب الشات", p_photos_first: "الصور الأول وبعدها الوصف", p_text_first: "الوصف الأول وبعدها الصور", p_mixed: "مختلط (مفيش قاعدة واحدة)", p_unknown: "مش واضح",
      reason_orphan: "مفيش وصف جنبها", reason_ambiguous: "بين وحدتين: اختار", reason_against_pattern: "عكس ترتيب الشات: اختار", reason_multi_code: "الرسالة فيها أكتر من كود: اختار", assign: "اكتب الكود", assigned: "اتوزعت على", skip: "سيبها",
      overCap: "زيادة عن الحد (بتتساب)", existing: "فيها صور بالفعل", missing: "مش موجودة في الملف", use: "استخدم", omitted: "صور متحملتش في التصدير", skippedMedia: "فيديو أو ملفات اتتخطت", duplicates: "بوستات مكررة",
      addNew: "ضيف الصور الجديدة بس", skipHave: "سيب الوحدات اللي فيها صور", apply: "ابدأ التحميل", cancel: "إلغاء", keepOpen: "سيب الصفحة مفتوحة والشاشة منورة لحد ما يخلص.",
      stageShrink: "تصغير وتحميل الصور", of: "من", left: "دقيقة متبقية تقريباً", done: "خلص", uploaded: "اتحملت", dup: "مكررة (موجودة)", full: "الوحدة اكتملت 15 صورة", unreadable: "مش قابلة للقراءة", failed: "فشلت", cancelled: "اتلغى",
      seeUnits: "افتح الوحدات", seeReview: "افتح المراجعة", nothing: "مفيش صور لتحميلها.", noPosts: "ملقيناش بوستات فيها وحدات.", cap: "بنقرا لحد 40 بوست في المرة. غيّر التاريخ للباقي.", post: "بوست", tooMany: "اتجاوزت الحد", rateWait: "بنستنى شوية…", startFail: "مقدرناش نبدأ التحميل. جرب تاني.",
      aiUpTo: "ذكاء اصطناعي: حتى", aiCredits: "رصيد", aiOffLabel: "من غير ذكاء اصطناعي: قراءة بالقواعد بس", 
      codeChecking: "بنراجع الأكواد…", codeNew: "وحدة جديدة", codeUpdate: "تحديث للوحدة", codeHas: "فيها صور", codeTaken: "الكود ده لوحدة مش من حقك تعدلها", codeDup: "نفس الكود في بوست", codeFail: "مقدرناش نراجع الأكواد دلوقتي: هتتراجع في المراجعة.",
      videos: "فيديو اتتخطى (مش بيتحمل)", videosTotal: "فيديو أو ملف اتتخطى ومش هيتحمل", pickNote: "اختار 15 صورة بس: أول 15 معلّمين، والباقي علّمه بإيدك. استخدم ◀ ▶ لترتيب الصور.", stageRead: "قراءة الملف", stageMatch: "توزيع الصور على البوستات", stagePosts: "قراءة بيانات الوحدات", stageUpload: "تحميل الصور", leaveWarn: "لو قفلت الصفحة التحميل هيقف.",
      verify: "راجع الصور", swap: "بدّل الصور مع الوحدة اللي بعدها", full15: "الوحدة وصلت 15 صورة. شيل علامة صورة تانية أو شيل صورة قديمة.", oldPhotos: "صور الوحدة الحالية: علّم اللي تتشال", removeFail: "مقدرناش نشيل الصور القديمة", heicFail: "صور HEIC متحولتش", converted: "صور اتحولت من HEIC", aiOff: "الذكاء الاصطناعي مش متاح: القراءة بالقواعد بس.", errors: "أخطاء", planFail: "مقدرناش نقرا البوستات. جرب تاني.", edit: "تعديل", editDone: "تم", description: "الوصف", original: "الرسالة الأصلية", summaryLoading: "جاري قراءة بيانات الوحدة…", missingField: "ناقص", missingNote: "بيانات ناقصة: اضغط تعديل وكملها، وإلا الوحدة مش هتتضاف.",
      discard: "تجاهل", restore: "رجّع", restoreAll: "رجّع الكل", discardedWord: "متجاهلة", discardErrors: "تجاهل الوحدات اللي فيها أخطاء", selectValid: "اختار كل الصالح", unchangedSkipped: "صورة لوحدات مفيش فيها تغيير (اتساب)",
      sumLine: function (n, a, b, m, x, z) { return "هيتحفظ " + n + " وحدة (" + a + " جديدة، " + b + " تحديث) · هيتساب " + m + " (أخطاء " + x + "، متجاهلة " + z + "). الوحدات اللي مفيش فيها تغيير بتتساب لوحدها بعد القراءة."; }
    },
    en: {
      lastImport: "Last import of this chat:", sinceLast: "Since last import",
      pick: "Choose the zip file first.", reading: "Reading the file…", noChat: "No chat text (.txt) inside the zip.", badZip: "That is not a readable zip.", encrypted: "The zip is password-protected.",
      noUnits: "There are no units in the agency yet. Import the sheet first or choose “Read units from the posts”.", big: "This file is big and a phone may stop. A computer is better.",
      photos: "photos", units: "units", noPhotos: "Units with no photos", tray: "Photos not placed", unknown: "Codes in the chat that are not in the app", pattern: "Chat order", p_photos_first: "photos first, then the description", p_text_first: "description first, then photos", p_mixed: "mixed (no single rule)", p_unknown: "not clear",
      reason_orphan: "no description next to it", reason_ambiguous: "between two units: choose", reason_against_pattern: "against the chat order: choose", reason_multi_code: "the message has several codes: choose", assign: "Type the code", assigned: "placed on", skip: "Leave out",
      overCap: "over the limit (left out)", existing: "already has photos", missing: "missing from the file", use: "Use", omitted: "photos not included in the export", skippedMedia: "videos or files skipped", duplicates: "duplicate posts",
      addNew: "Add new photos only", skipHave: "Skip units that already have photos", apply: "Start upload", cancel: "Cancel", keepOpen: "Keep this page open and the screen on until it finishes.",
      stageShrink: "Shrinking and uploading photos", of: "of", left: "min left (about)", done: "Done", uploaded: "uploaded", dup: "duplicates (already there)", full: "unit already has 15 photos", unreadable: "unreadable", failed: "failed", cancelled: "Cancelled",
      seeUnits: "Open units", seeReview: "Open the review", nothing: "No photos to upload.", noPosts: "No posts describing a unit were found.", cap: "Up to 40 posts at a time. Change the date for the rest.", post: "Post", tooMany: "over the limit", rateWait: "Waiting a moment…", startFail: "Could not start the import. Try again.",
      aiUpTo: "AI: up to", aiCredits: "credits", aiOffLabel: "no AI: rules only", 
      codeChecking: "Checking the codes…", codeNew: "New unit", codeUpdate: "Updates unit", codeHas: "already has photos", codeTaken: "Code belongs to a unit you can't change", codeDup: "Same code as post", codeFail: "Could not check the codes now: they are checked again in the review.",
      videos: "videos skipped (not uploaded)", videosTotal: "videos or files skipped and not uploaded", pickNote: "Choose 15 photos only: the first 15 are ticked, tick the others by hand. Use ◀ ▶ to put the photos in order.", stageRead: "Reading the file", stageMatch: "Placing photos on posts", stagePosts: "Reading the units", stageUpload: "Uploading photos", leaveWarn: "Closing this page stops the upload.",
      verify: "Verify photos", swap: "Swap photos with the next unit", full15: "The unit is at 15 photos. Untick another photo or remove an old one.", oldPhotos: "The unit's current photos: tick the ones to remove", removeFail: "Could not remove the old photos", heicFail: "HEIC photos that could not be converted", converted: "photos converted from HEIC", aiOff: "AI is not available: read with the rules only.", errors: "Errors", planFail: "Could not read the posts. Try again.", edit: "Edit", editDone: "Done", description: "Description", original: "Original message", summaryLoading: "Reading the unit details…", missingField: "Missing", missingNote: "Details missing: press Edit and complete them, or the unit will not be added.",
      discard: "Discard", restore: "Restore", restoreAll: "Restore all", discardedWord: "discarded", discardErrors: "Discard units with errors", selectValid: "Select all valid", unchangedSkipped: "photos of unchanged units (skipped)",
      sumLine: function (n, a, b, m, x, z) { return "Will save " + n + " units (" + a + " new, " + b + " updated) · skipping " + m + " (errors " + x + ", discarded " + z + "). Units with no changes are skipped automatically after reading."; }
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
  // A stage with a real percentage (a bar and the number), so a long read never looks stuck.
  var stage = function (label, pct) {
    out.textContent = "";
    out.appendChild(el("div", { class: "card stack", role: "status", "data-cp-stage": true }, [el("strong", { text: label + " · " + pct + "%" }), el("progress", { max: "100", value: String(pct) })]));
    return sleep(15);
  };
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
    await stage(TEXT.stageRead, 5);
    var zip = null;
    var text;
    var chatName = file.name;
    try {
      if (/\.txt$/i.test(file.name)) {
        text = await file.text();
        chatName = file.name;
      } else {
        zip = await timed("read_zip", function () { return ZipRead.open(file); }, { mb: Math.round(file.size / 1048576) });
        await stage(TEXT.stageRead, 15);
        var txts = zip.entries.filter(function (e) { return /\.txt$/i.test(e.name) && e.size <= 40 * 1024 * 1024; })
          .sort(function (a, b) { return Number(/chat/i.test(base(b.name))) - Number(/chat/i.test(base(a.name))); });
        if (!txts.length) return say(TEXT.noChat, true);
        text = await timed("read_chat", function () { return zip.text(txts[0]); });
        chatName = txts[0].name;
      }
    } catch (err) {
      flush();
      return say(err && err.code === "ENCRYPTED" ? TEXT.encrypted : TEXT.badZip, true);
    }
    await stage(TEXT.stageMatch, 30);
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
    state = { file: file, zip: zip, text: text, byName: byName, byLower: byLower, mode: mode, units: units, aliases: {}, assigned: {}, pick: {}, files: {}, drops: {}, olds: {}, skipped: {}, discarded: {}, sumFailed: false, sumCache: {}, fields: {}, modal: null, codeInfo: null, codeState: null };
    if (file.size > 1024 * 1024 * 1024 && /Mobi|Android|iPhone/i.test(navigator.userAgent)) state.bigWarn = true;
    await rememberChat(chatName, text);
    compute();
  }

  var entryOf = function (name) { return state.byName[name] || state.byLower[String(name).toLowerCase()] || null; };

  // The date range: the same options and the same code (ChatParse.rangeBounds) as the group form and the app.
  function bounds() {
    var kind = $("range") ? $("range").value : "custom";
    var custom = root.querySelector("[data-range-custom]");
    if (custom) custom.hidden = kind !== "custom";
    return window.ChatParse && ChatParse.rangeBounds ? ChatParse.rangeBounds(kind, { lastImportAt: state && state.lastImportAt, since: $("since") ? $("since").value : null, until: $("until") ? $("until").value : null }) : { since: $("since") && $("since").value || null, until: null };
  }

  // The chat's own id (file name + first message header, domain/chatFingerprint.js) and what the agency decided about it before.
  async function rememberChat(name, text) {
    if (!window.ChatFingerprint) return;
    state.chatFp = ChatFingerprint.chatFingerprint(name, ChatFingerprint.firstHeaderOf(text));
    var url = root.getAttribute("data-decisions-url");
    if (!url || state.mode !== "posts") return;
    try {
      var r = await fetch(url + "?chat_fp=" + state.chatFp, { credentials: "same-origin" });
      var j = r.ok ? await r.json() : {};
      state.lastImportAt = j.last_import_at || null;
    } catch (e) { state.lastImportAt = null; }
    var sel = $("range");
    var opt = sel && sel.querySelector('option[value="last"]');
    if (opt && state.lastImportAt) {
      opt.hidden = false; opt.disabled = false;
      sel.value = "last";
      var note = $("last-note");
      if (note) note.textContent = TEXT.lastImport + " " + String(state.lastImportAt).slice(0, 10);
    } else if (opt) { opt.hidden = true; opt.disabled = true; if (sel.value === "last") sel.value = "30"; }
  }

  function compute() {
    var codes = state.units ? state.units.map(function (u) { return u.code; }) : null;
    var t0 = Date.now();
    state.res = ChatMatch.match(state.text, {
      since: bounds().since, until: bounds().until, windowMin: Number($("window").value) || 10, sameSender: $("same").checked, pattern: $("pattern").value, codes: codes, aliases: state.aliases
    });
    state.files = {};
    steps.push({ step: "match", ms: Date.now() - t0, ok: true, meta: { messages: state.res.stats.messages, photos: state.res.stats.photos, dividers: state.res.stats.dividers || 0, tray: state.res.tray.length } });
    flush();
    render();
    checkCodes();
    loadSummaries();
  }

  // Posts mode: the codes the posts write are checked against the agency's units in one separate server call, right after the
  // zip is read, so a post for an existing unit shows as an update (never as new) before anything is uploaded.
  var codeAsk = 0;
  function checkCodes() {
    if (!state || state.res.mode !== "posts" || !root.getAttribute("data-codes-url")) return;
    var codes = [];
    state.res.posts.forEach(function (p) { if (p.code && codes.indexOf(p.code) < 0) codes.push(p.code); });
    if (!codes.length) { state.codeState = "done"; return; }
    var ask = ++codeAsk;
    var tCodes = Date.now();
    state.codeState = "checking";
    render();
    fetch(root.getAttribute("data-codes-url"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ codes: codes }) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("http_" + r.status)); })
      .then(function (j) { if (ask !== codeAsk) return; steps.push({ step: "codes", ms: Date.now() - tCodes, ok: true, meta: { codes: codes.length } }); flush(); state.codeInfo = j.codes || {}; state.codeState = "done"; render(); })
      .catch(function (err) { if (ask !== codeAsk) return; steps.push({ step: "codes", ms: Date.now() - tCodes, ok: false, error: (err && err.message) || "codes_failed", meta: { codes: codes.length } }); flush(); state.codeState = "failed"; render(); });
  }

  // ---- showing the result ----------------------------------------------------------------------------------------
  // Which photos are ticked: the person's choice, else the first ones that fit (a unit holds 15).
  var pickOf = function (ref, k, slots) { return state.pick[ref.name] === undefined ? k < slots : state.pick[ref.name]; };
  // Put one photo before/after its neighbour: the order is the order they are saved in (the unit's first photo is the cover).
  function movePhoto(id, refs, k, by) {
    var j = k + by;
    if (j < 0 || j >= refs.length) return;
    var list = refs.slice();
    var tmp = list[k]; list[k] = list[j]; list[j] = tmp;
    state.files[id] = list;
    render();
  }
  function thumbs(refs, limit, slots, moveId) {
    var box = el("div", { class: "row thumbs" + (moveId ? " big" : "") });
    var room = slots === undefined ? MAXP : slots;
    refs.slice(0, limit || refs.length).forEach(function (ref, k) {
      var entry = state.zip ? entryOf(ref.name) : null;
      var cell = el("label", { class: "thumb" });
      var box1 = el("input", { type: "checkbox", checked: Boolean(entry) && pickOf(ref, k, room), disabled: !entry, on: { change: function (ev) {
        var on = refs.filter(function (r, i) { return r.name !== ref.name && entryOf(r.name) && pickOf(r, i, room); }).length;
        if (ev.target.checked && on >= room) { ev.target.checked = false; say(TEXT.full15, true); return; }
        state.pick[ref.name] = ev.target.checked;
        if (moveId) {
          var counter = root.querySelector('[data-cp-count="' + moveId + '"]');
          if (counter) counter.textContent = refs.filter(function (r2, i2) { return entryOf(r2.name) && pickOf(r2, i2, room); }).length + " / " + MAXP + " " + TEXT.photos;
        }
      } } });
      cell.appendChild(box1);
      if (!entry) cell.appendChild(el("span", { class: "muted", text: TEXT.missing }));
      else {
        var size = moveId ? "96" : "64";
        var img = el("img", { alt: "", width: size, height: size, loading: "lazy" });
        state.zip.blob(entry).then(function (b) { return previewOf(b, ref.name); }).then(function (b) { img.src = URL.createObjectURL(b); img.onload = function () { URL.revokeObjectURL(img.src); }; }).catch(function () {});
        cell.appendChild(img);
      }
      if (moveId) {
        cell.appendChild(el("span", { class: "row move" }, [
          el("button", { type: "button", class: "secondary small", "data-cp-move": "earlier", text: lang === "ar" ? "▶" : "◀", on: { click: function (ev) { ev.preventDefault(); movePhoto(moveId, refs, k, -1); } } }),
          el("button", { type: "button", class: "secondary small", "data-cp-move": "later", text: lang === "ar" ? "◀" : "▶", on: { click: function (ev) { ev.preventDefault(); movePhoto(moveId, refs, k, 1); } } })
        ]));
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

  var textOf = function (x) { return x.text; };
  // The message exactly as it was written in WhatsApp (shown to compare with what was read).
  var origOf = function (x) { return x.orig || x.text; };
  // The person's Edit-window form for a post (null until edited): it goes on top of what the reader found, here and at upload.
  var fieldsOf = function (x) { return state.fields[String(x.i)] || null; };
  var sumKey = function (x) { return textOf(x) + "|#|" + JSON.stringify(fieldsOf(x)); };
  // ---- unit summary (rules-only read of each post, from the server) -------------------------------------------------
  var LABELS = {
    ar: { listing_type: "بيع / إيجار", property_type: "النوع", compound: "الكمبوند", district: "المنطقة", address: "العنوان", price_value: "السعر", area_value: "المساحة", bedrooms: "الغرف", bathrooms: "الحمامات", floor: "الدور", finishing: "التشطيب", delivery: "التسليم", down_payment_value: "المقدم", remaining_amount: "المتبقي", installment_value: "القسط", installment_frequency: "دورية القسط", features: "المميزات", owner_name: "المالك", owner_phone: "تليفون", code: "الكود", land_area: "مساحة الأرض", notes: "ملاحظات" },
    en: { listing_type: "Sale / rent", property_type: "Type", compound: "Compound", district: "District", address: "Address", price_value: "Price", area_value: "Area", bedrooms: "Bedrooms", bathrooms: "Bathrooms", floor: "Floor", finishing: "Finishing", delivery: "Delivery", down_payment_value: "Down payment", remaining_amount: "Remaining", installment_value: "Installment", installment_frequency: "Frequency", features: "Features", owner_name: "Owner", owner_phone: "Phone", code: "Code", land_area: "Land area", notes: "Notes" }
  }[lang];
  var ORDER = ["listing_type", "property_type", "compound", "district", "address", "price_value", "area_value", "land_area", "bedrooms", "bathrooms", "floor", "finishing", "delivery", "down_payment_value", "remaining_amount", "installment_value", "installment_frequency", "features", "owner_name", "owner_phone"];
  var SHOWN_VALUE = { sale: lang === "en" ? "Sale" : "بيع", rent: lang === "en" ? "Rent" : "إيجار" };
  var summaryOf = function (x) { return state.sumCache[sumKey(x)] || null; };
  function loadSummaries() {
    var url = root.getAttribute("data-summary-url");
    if (!url || !state || !state.res || state.res.mode !== "posts") return Promise.resolve();
    var asked = [];
    var keys = [];
    state.res.posts.forEach(function (p) { var k = sumKey(p); if (!state.sumCache[k] && keys.indexOf(k) < 0) { keys.push(k); asked.push({ text: textOf(p), fields: fieldsOf(p) }); } });
    if (!asked.length) return Promise.resolve();
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ posts: asked }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (!j) return; keys.forEach(function (k, n) { state.sumCache[k] = j.posts[n] || { cells: {}, missing: [] }; }); render(); })
      .catch(function () { state.sumFailed = true; render(); });
  }
  // Whether a post is saved. Default: ON only when its details are complete and its code is usable; OFF for missing mandatory
  // details, a code that belongs to a unit the person may not change, or a code repeated in this zip. A blocked post cannot be
  // ticked (the reason is on its card) until it is fixed. The person's own tick only counts when nothing blocks it. The server
  // checks everything again, so this is the first guard, never the only one.
  function blockOf(x) {
    if (!state || state.res.mode !== "posts") return null;
    var posts = state.res.posts;
    if (x.code) {
      var first = null;
      posts.forEach(function (o, k) { if (first === null && o.code === x.code) first = k; });
      if (first !== null && first !== posts.indexOf(x)) return TEXT.codeDup + " " + (first + 1) + ": " + x.code;
      var info = state.codeInfo && state.codeInfo[x.code];
      if (info && info.state === "taken") return TEXT.codeTaken;
    }
    var sum = summaryOf(x);
    if (sum && (sum.missing || []).length) return TEXT.missingNote;
    return null;
  }
  function isIncluded(x) {
    var id = String(x.i);
    if (state.discarded[id] || blockOf(x)) return false;
    if (state.skipped[id] !== undefined) return !state.skipped[id];
    return Boolean(summaryOf(x)) || state.sumFailed;
  }
  var includedPosts = function () { return state.res.posts.filter(isIncluded); };
  // The unit as a short summary (what the reader found) with the required things it could not find marked in red.
  function summaryBox(x) {
    var sum = summaryOf(x);
    if (!sum) return el("p", { class: "muted", text: TEXT.summaryLoading });
    var cells = sum.cells || {};
    var missing = sum.missing || [];
    var keys = ORDER.filter(function (k) { return cells[k] !== undefined || missing.indexOf(k) >= 0; });
    Object.keys(cells).forEach(function (k) { if (ORDER.indexOf(k) < 0 && k !== "code" && k !== "description" && k !== "notes" && keys.indexOf(k) < 0) keys.push(k); });
    var grid = el("dl", { class: "uc-grid", "data-cp-summary-grid": true });
    keys.forEach(function (k) {
      var miss = missing.indexOf(k) >= 0 && cells[k] === undefined;
      var v = cells[k] === undefined ? "" : (SHOWN_VALUE[cells[k]] || cells[k]);
      grid.appendChild(el("div", { class: "uc-field" + (miss ? " missing" : ""), "data-field": k }, [el("dt", { text: LABELS[k] || k }), el("dd", { text: miss ? "⚠️ " + TEXT.missingField : v })]));
    });
    var box = el("div", { class: "stack", "data-cp-summary-box": true }, [grid]);
    if (missing.length) box.appendChild(el("p", { class: "warn", "data-cp-missing": missing.join(","), text: "⚠️ " + TEXT.missingNote }));
    return box;
  }

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

  // The state of a post's code: update of an existing unit, a free code, a unit the person may not change, or a repeat in this zip.
  function codeBadge(x, list) {
    if (!x.code) return null;
    var first = null;
    list.forEach(function (o, k) { if (first === null && o.code === x.code) first = k; });
    var mine = list.indexOf(x);
    if (first !== null && first !== mine) return el("span", { class: "warn", "data-cp-code-state": "dup", text: "⚠️ " + TEXT.codeDup + " " + (first + 1) + ": " + x.code });
    if (state.codeState === "checking") return el("span", { class: "muted", "data-cp-code-state": "checking", text: TEXT.codeChecking });
    if (state.codeState === "failed") return el("span", { class: "muted", "data-cp-code-state": "failed", text: TEXT.codeFail });
    var info = state.codeInfo && state.codeInfo[x.code];
    if (!info) return null;
    if (info.state === "update") return el("span", { class: "chip on", "data-cp-code-state": "update", text: "🔄 " + TEXT.codeUpdate + " " + info.code + (info.photos ? " · " + info.photos + " " + TEXT.codeHas : "") });
    if (info.state === "taken") return el("span", { class: "warn", "data-cp-code-state": "taken", text: "⛔ " + TEXT.codeTaken });
    return el("span", { class: "chip", "data-cp-code-state": "new", text: "🆕 " + TEXT.codeNew + " " + x.code });
  }

  // A thin strip of the first photos on the unit card (the photos themselves are handled in the Edit window).
  function miniStrip(refs, slots) {
    var box = el("div", { class: "row mini-strip", "data-cp-strip": true });
    var shown = refs.filter(function (f, i) { return entryOf(f.name) && pickOf(f, i, slots); });
    shown.slice(0, 5).forEach(function (ref) {
      var img = el("img", { alt: "", width: "56", height: "56", loading: "lazy" });
      state.zip.blob(entryOf(ref.name)).then(function (b) { return previewOf(b, ref.name); }).then(function (b) { img.src = URL.createObjectURL(b); img.onload = function () { URL.revokeObjectURL(img.src); }; }).catch(function () {});
      box.appendChild(img);
    });
    if (shown.length > 5) box.appendChild(el("span", { class: "muted", text: "+" + (shown.length - 5) }));
    return box;
  }
  // The form in the Edit window → { name: value | [values] } (what the server's cellsFromForm reads).
  function formFields(form) {
    var data = new FormData(form);
    var out = {};
    data.forEach(function (v, k) {
      if (k === "_csrf" || typeof v !== "string") return;
      if (out[k] === undefined) out[k] = v;
      else out[k] = [].concat(out[k], v);
    });
    return out;
  }
  // Keeps the person's edits when the page redraws (a photo move, Done): read from the open form, if there is one.
  function syncFields() {
    if (!state || !state.modal) return;
    var form = root.querySelector("[data-cp-unitform]");
    if (form && form.getAttribute("data-ready")) state.fields[state.modal] = formFields(form);
  }
  // The Edit window of a unit: the post text and all its photos (tick, order). The card behind keeps its summary.
  function editModal(c) {
    var close = function () { syncFields(); state.modal = null; render(); loadSummaries(); };
    var picked = c.refs.filter(function (f, i) { return entryOf(f.name) && pickOf(f, i, c.slots); }).length;
    // The standard unit controls (place search with chips, sale/rent chips, dropdowns), made by the server from what the reader found.
    var form = el("form", { class: "stack", "data-cp-unitform": c.id, "data-unit-edit-form": true, on: { submit: function (ev) { ev.preventDefault(); } } }, [el("p", { class: "muted", text: TEXT.summaryLoading })]);
    var tokenInput = el("input", { type: "hidden", name: "_csrf", value: csrf });
    fetch(root.getAttribute("data-editor-url"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ text: textOf(c.x), fields: fieldsOf(c.x) }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        form.innerHTML = j.html;
        form.appendChild(tokenInput);
        form.setAttribute("data-ready", "1");
        if (window.UnitBox) window.UnitBox.init(form);
      })
      .catch(function () {});
    var dlg = el("dialog", { class: "edit-dialog cp-modal", "data-cp-modal": c.id }, [
      el("div", { class: "stack" }, [
        el("h2", { text: "✏️ " + TEXT.edit + " · " + TEXT.post + " " + (c.k + 1) }),
        form,
        el("details", { class: "ie-original", open: true, "data-cp-original": c.id }, [el("summary", { text: "💬 " + TEXT.original }), el("p", { dir: "auto", text: origOf(c.x) })]),
        c.refs.length ? el("p", { class: "muted", "data-cp-count": c.id, text: picked + " / " + MAXP + " " + TEXT.photos }) : null,
        c.refs.length > MAXP ? el("p", { class: "warn", text: TEXT.pickNote }) : null,
        c.refs.length ? thumbs(c.refs, 0, c.slots, c.id) : el("p", { class: "muted", text: "0 " + TEXT.photos }),
        el("div", { class: "row" }, [el("button", { type: "button", "data-cp-editdone": c.id, text: "✔ " + TEXT.editDone, on: { click: close } })])
      ])
    ]);
    dlg.addEventListener("cancel", function (ev) { ev.preventDefault(); close(); });
    setTimeout(function () { if (dlg.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); } } else dlg.setAttribute("open", ""); }, 0);
    return dlg;
  }

  function render() {
    syncFields();
    var r = state.res;
    out.textContent = "";
    if (state.bigWarn) out.appendChild(el("p", { class: "card notice", text: TEXT.big }));
    var totalPhotos = 0;
    var list = entries();
    list.forEach(function (x) { totalPhotos += x.files.length; });
    out.appendChild(el("p", { class: "card", "data-cp-summary": true, text: list.length + " " + TEXT.units + " · " + totalPhotos + " " + TEXT.photos + " · " + TEXT.pattern + ": " + TEXT["p_" + r.pattern] + (r.stats.omittedMedia ? " · " + r.stats.omittedMedia + " " + TEXT.omitted : "") + (r.stats.skippedMedia ? " · " + r.stats.skippedMedia + " " + TEXT.skippedMedia : "") + (r.stats.duplicates ? " · " + r.stats.duplicates + " " + TEXT.duplicates : "") }));
    if (r.stats.truncated) out.appendChild(el("p", { class: "muted", text: TEXT.cap }));
    if (r.mode === "posts") out.appendChild(bulkBar());

    var existing = {};
    (state.units || []).forEach(function (u) { existing[u.code] = u.photos; });
    var ol = el("ol", { class: "results", "data-cp-list": true });
    var modalCtx = null;
    list.forEach(function (x, k) {
      if (r.mode === "posts" && state.discarded[String(x.i)]) return;
      var id = r.mode === "codes" ? x.code : String(x.i);
      var seenRef = {};
      var refs = filesOf(x).concat(assignedTo(id)).filter(function (f) { if (seenRef[f.name]) return false; seenRef[f.name] = true; return true; });
      var gallery = r.mode === "posts";
      var slots = Math.max(0, MAXP - (existing[id] || 0) + dropCount(id));
      // The sender is often a phone number: keep it left-to-right inside Arabic text ("+20 111 161 6455", not "20 111 161 6455 +"). A name stays auto.
      var titleNode = function () {
        var strong = el("strong", { text: r.mode === "codes" ? x.code : TEXT.post + " " + (k + 1) });
        if (r.mode !== "codes" && x.sender) {
          strong.appendChild(document.createTextNode(" · "));
          strong.appendChild(el("bdi", { dir: /^[+\d\s().-]+$/.test(x.sender) ? "ltr" : "auto", text: x.sender }));
        }
        return strong;
      };
      var badge = gallery ? codeBadge(x, list) : null;
      var picked = refs.filter(function (f, i) { return entryOf(f.name) && pickOf(f, i, slots); }).length;
      var info = refs.length + " " + TEXT.photos + (existing[id] ? " · " + TEXT.existing + " (" + existing[id] + ")" : "") + (x.over ? " · " + x.over + " " + TEXT.overCap : "") + (refs.length > slots ? " · " + slots + " / " + MAXP : "") + (x.videos ? " · 🎞 " + x.videos + " " + TEXT.videos : "");
      var editBtn = gallery ? el("button", { type: "button", class: "secondary small", "data-cp-edit": id, text: "✏️ " + TEXT.edit, on: { click: function () { state.modal = id; render(); } } }) : null;
      var warnings = el("div", { class: "row uc-warns" }, [
        x.verify ? el("span", { class: "warn", "data-cp-verify": id, text: "⚠️ " + TEXT.verify }) : null,
        x.verify && list[k + 1] ? el("button", { type: "button", class: "secondary small", "data-cp-swap": id, text: "⇄ " + TEXT.swap, on: { click: function () { swapWithNext(list, k); } } }) : null
      ]);
      if (gallery) {
        if (state.modal === id) modalCtx = { id: id, x: x, refs: refs, slots: slots, k: k };
        var reason = blockOf(x);
        var discardBtn = el("button", { type: "button", class: "secondary small", "data-cp-discard": id, text: "🗑 " + TEXT.discard, on: { click: function () { state.discarded[id] = true; render(); } } });
        ol.appendChild(el("li", { class: "card unit-card" + (reason ? " is-bad" : ""), "data-cp-unit": id }, [
          el("div", { class: "uc-head" }, [
            el("input", { type: "checkbox", "data-cp-pick": id, checked: isIncluded(x), disabled: Boolean(reason), title: reason || null, on: { change: function (ev) { state.skipped[id] = !ev.target.checked; refreshApply(); } } }),
            el("div", { class: "uc-title" }, [badge, titleNode(), el("span", { class: "muted", text: info })]),
            x.code ? el("span", { class: "uc-code", text: x.code }) : null,
            editBtn,
            discardBtn
          ]),
          reason ? el("div", { class: "uc-alert", role: "alert", "data-cp-block": id, text: "⛔ " + reason }) : null,
          x.text ? summaryBox(x) : null,
          x.text ? el("details", { class: "ie-original", "data-cp-original": id }, [el("summary", { text: "💬 " + TEXT.original }), el("p", { dir: "auto", text: origOf(x) })]) : null,
          warnings,
          refs.length ? miniStrip(refs, slots) : null
        ]));
        return;
      }
      ol.appendChild(el("li", { class: "card", "data-cp-unit": id }, [
        el("div", { class: "row" }, [
          el("input", { type: "checkbox", "data-cp-pick": id, checked: !state.skipped[id], on: { change: function (ev) { state.skipped[id] = !ev.target.checked; refreshApply(); } } }),
          titleNode(),
          el("span", { class: "muted", text: info })
        ]),
        warnings,
        refs.length ? lazy(refs.length + " " + TEXT.photos, refs, slots) : null,
        r.mode === "codes" && existing[id] ? oldPhotos(id) : null
      ]));
    });
    out.appendChild(ol);
    if (modalCtx) out.appendChild(editModal(modalCtx));

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
    if (r.mode === "posts") out.appendChild(el("p", { class: "card notice", role: "status", "data-cp-save-line": true, text: saveLine() }));
    out.appendChild(el("div", { class: "cp-actions" }, [el("button", { type: "button", "data-cp-apply": true, disabled: r.mode === "posts" && !includedPosts().length, text: applyLabel(), on: { click: apply } })]));
  }

  // Posts mode, above the list: discard / select in bulk, and the posts thrown out (with Restore).
  function bulkBar() {
    var posts = state.res.posts;
    var live = posts.filter(function (x) { return !state.discarded[String(x.i)]; });
    var bad = live.filter(function (x) { return blockOf(x); });
    var gone = posts.filter(function (x) { return state.discarded[String(x.i)]; });
    var bar = el("div", { class: "card stack", "data-cp-bulk": true });
    var row = el("div", { class: "row" }, [
      el("button", { type: "button", class: "secondary small", "data-cp-select-valid": true, text: "✔ " + TEXT.selectValid, on: { click: function () { live.forEach(function (x) { if (!blockOf(x)) state.skipped[String(x.i)] = false; }); render(); } } }),
      bad.length ? el("button", { type: "button", class: "secondary small", "data-cp-discard-errors": true, text: "🗑 " + TEXT.discardErrors + " (" + bad.length + ")", on: { click: function () { bad.forEach(function (x) { state.discarded[String(x.i)] = true; }); render(); } } }) : null
    ]);
    bar.appendChild(row);
    if (gone.length) {
      var d = el("details", { "data-cp-discarded": String(gone.length) }, [el("summary", { text: "🗑 " + gone.length + " " + TEXT.discardedWord + " · " + TEXT.restore })]);
      var ul = el("ul", {});
      gone.forEach(function (x) {
        ul.appendChild(el("li", {}, [el("span", { class: "muted", text: TEXT.post + " " + (posts.indexOf(x) + 1) + " " }), el("button", { type: "button", class: "secondary small", "data-cp-restore": String(x.i), text: "↩ " + TEXT.restore, on: { click: function () { delete state.discarded[String(x.i)]; render(); } } })]));
      });
      d.appendChild(ul);
      d.appendChild(el("button", { type: "button", class: "secondary small", "data-cp-restore-all": true, text: "↩ " + TEXT.restoreAll, on: { click: function () { state.discarded = {}; render(); } } }));
      bar.appendChild(d);
    }
    return bar;
  }
  // "Will save N units (A new, B updated) · skipping M (errors X, discarded Z)": counted from what is ticked now.
  function saveLine() {
    var posts = state.res.posts;
    var on = includedPosts();
    var upd = on.filter(function (x) { var i = state.codeInfo && x.code && state.codeInfo[x.code]; return i && i.state === "update"; }).length;
    var errs = posts.filter(function (x) { return !state.discarded[String(x.i)] && blockOf(x); }).length;
    var gone = posts.filter(function (x) { return state.discarded[String(x.i)]; }).length;
    return TEXT.sumLine(on.length, on.length - upd, upd, posts.length - on.length, errs, gone);
  }

  // The upload button says what AI may cost: up to the per-post credits × the posts ticked (only a post the normal reader cannot
  // read is sent to AI), or that it is rules only. Units photos-by-code never use AI.
  var aiBox = function () { return $("ai"); };
  var aiOn = function () { return Boolean(aiBox() && aiBox().checked); };
  function applyLabel() {
    if (!state || state.res.mode !== "posts") return TEXT.apply;
    var n = includedPosts().length;
    var base = TEXT.apply + " (" + n + ")";
    if (!aiBox()) return base;
    if (!aiOn()) return base + " · " + TEXT.aiOffLabel;
    var cost = Number(root.getAttribute("data-ai-cost")) || 0;
    return cost ? base + " · " + TEXT.aiUpTo + " " + cost * n + " " + TEXT.aiCredits : base;
  }
  // The button says how many units it will save and is off at 0; the line above it says what is skipped and why.
  function refreshApply() {
    var b = root.querySelector("[data-cp-apply]");
    if (b) {
      b.textContent = applyLabel();
      if (state && state.res.mode === "posts") b.disabled = !includedPosts().length;
    }
    var line = root.querySelector("[data-cp-save-line]");
    if (line && state && state.res.mode === "posts") line.textContent = saveLine();
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
      if (r.mode === "posts" ? !includedPosts().some(function (x) { return String(x.i) === id; }) : state.skipped[id]) return;
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
    if (postsMode ? !includedPosts().length : !p.tasks.length) return say(TEXT.nothing, true);
    var importId = null;
    var aiNote = null;
    var untouched = 0;
    if (postsMode) {
      var chosen = includedPosts();
      var j0 = null;
      await stage(TEXT.stagePosts + " (" + chosen.length + ")", 35);
      try {
        j0 = await timed("plan", async function () {
          var r0 = await fetch(root.getAttribute("data-plan-url"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ filename: state.file.name, chat_fp: state.chatFp || null, ai: aiOn(), posts: chosen.map(function (x) { return { sender: x.sender, at: x.at, text: textOf(x), orig: origOf(x), fields: fieldsOf(x) }; }) }) });
          var j = await r0.json().catch(function () { return {}; });
          if (!r0.ok || !j.id) { var e = new Error(j.message || (r0.status === 422 ? TEXT.noPosts : TEXT.planFail)); e.code = j.error || "http_" + r0.status; throw e; }
          return j;
        }, { posts: chosen.length, ai: aiOn() });
      } catch (err) {
        flush();
        return say(err.message || TEXT.planFail, true);
      }
      importId = j0.id;
      aiNote = j0.message || null;
      var index = {};
      chosen.forEach(function (x, k) { index[String(x.i)] = k; });
      // A post the plan found to be an existing unit with no changes (or not the person's) is not saved: its photos are not uploaded.
      var kinds = j0.kinds || {};
      var memory = j0.remembered || {};
      var before = p.tasks.length;
      // A post saved or discarded in an earlier import of this chat is not saved again: its photos are not uploaded either.
      p.tasks = p.tasks.filter(function (t) { var row = String(index[t.id] + 1); var kd = kinds[row]; return kd !== "unchanged" && kd !== "forbidden" && memory[row] !== "saved" && memory[row] !== "discarded"; });
      untouched = before - p.tasks.filter(function (t) { return index[t.id] !== undefined; }).length;
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
    run = { cancelled: false, done: 0, total: p.tasks.length, started: Date.now(), counts: { ok: 0, dup: 0, full: 0, unreadable: 0, failed: 0, heic: 0, missing: p.gone, skipped: untouched }, converted: 0, errors: {}, aiNote: aiNote, dropFail: typeof dropFail === "number" ? dropFail : 0, note: "" };
    var wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch (err) { wake = null; }
    out.textContent = "";
    var bar = el("progress", { max: String(run.total), value: "0", "data-cp-progress": true });
    var line = el("p", { "data-cp-progress-text": true });
    var cancel = el("button", { type: "button", class: "secondary", text: TEXT.cancel, on: { click: function () { run.cancelled = true; } } });
    var title = el("strong", { text: TEXT.stageUpload + " · 0%" });
    out.appendChild(el("div", { class: "card stack", "data-cp-upload": true }, [title, bar, line, el("p", { class: "muted", text: TEXT.keepOpen + " " + TEXT.leaveWarn }), cancel]));
    var leave = function (ev) { ev.preventDefault(); ev.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", leave);
    run.unload = function () { window.removeEventListener("beforeunload", leave); };
    var tick = function () {
      bar.value = run.done;
      var pct = run.total ? Math.round((run.done / run.total) * 100) : 100;
      title.textContent = TEXT.stageUpload + " · " + pct + "%";
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
          else if (b.skipped) run.counts.skipped++;
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
    if (run.unload) run.unload();
    finish(importId);
  }

  function finish(importId) {
    var c = run.counts;
    out.textContent = "";
    var parts = [[c.ok, TEXT.uploaded], [c.dup, TEXT.dup], [c.full, TEXT.full], [c.unreadable, TEXT.unreadable], [c.missing, TEXT.missing], [c.skipped, TEXT.unchangedSkipped], [c.failed, TEXT.failed]].filter(function (x) { return x[0]; }).map(function (x) { return x[0] + " " + x[1]; });
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
    if (importId && !run.cancelled && !errs.length && !c.failed && !c.heic) window.location.replace("/app/import/" + importId);
  }

  // The Read button is locked and shows a spinner until the unit list and the reading are done.
  $("read").addEventListener("click", function () {
    var b = this;
    b.classList.add("busy");
    b.disabled = true;
    Promise.resolve(load()).finally(function () { b.classList.remove("busy"); b.disabled = false; });
  });
  if ($("ai")) $("ai").addEventListener("change", refreshApply);
  ["window", "pattern", "same", "since", "until", "range"].forEach(function (n) { $(n).addEventListener("change", function () { if (state) compute(); else bounds(); }); });
  });
})();
