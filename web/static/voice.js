// Voice recording UI shared by every record button (search bar in app.js, unit form, leads, catalogue updates).
// WHRail.open() shows the WhatsApp-Web style recording rail: bin (discard) on the left, blinking dot and timer, and
// optionally a send button. Click to start, click send to stop and send, click the bin or press Esc to discard.
// The rail's buttons are plain clicks: no dragging or sliding.
(function () {
  "use strict";
  var EN = document.documentElement.lang === "en";
  var T = EN
    ? { bin: "Discard recording", send: "Send recording", time: "Recording time", rec: "Recording", gone: "Recording discarded", sent: "Recording sent" }
    : { bin: "إلغاء التسجيل", send: "إرسال التسجيل", time: "مدة التسجيل", rec: "بيسجّل", gone: "اتلغى التسجيل", sent: "التسجيل اتبعت" };
  var svg = function (d) { return '<svg class="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + "</svg>"; };
  var ICON = {
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>')
  };
  var live = null;
  // One polite status line for screen readers. The timer itself is never announced.
  function announce(text) {
    if (!live) {
      live = document.createElement("div");
      live.className = "sr-only";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      document.body.appendChild(live);
    }
    live.textContent = "";
    setTimeout(function () { live.textContent = text; }, 30);
  }
  function mmss(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  // opts: parent, before (node to insert in front of), send (true: the rail has its own send button),
  // onSend, onDiscard. Returns { el, sendButton, close(), discard(done) }.
  function open(opts) {
    var el = document.createElement("div");
    el.className = "vrail";
    el.setAttribute("data-vrail", "");
    el.innerHTML =
      '<button type="button" class="vr-bin" data-vr-bin aria-label="' + T.bin + '" title="' + T.bin + '"><span class="vr-drop">' + ICON.mic + "</span>" + ICON.trash + "</button>" +
      '<span class="vr-dot" aria-hidden="true"></span><span class="vr-time" role="timer" aria-live="off" aria-label="' + T.time + '">0:00</span>' +
      (opts.send ? '<button type="button" class="vr-send" data-vr-send aria-label="' + T.send + '" title="' + T.send + '">' + ICON.send + "</button>" : "");
    opts.parent.insertBefore(el, opts.before || null);
    var t0 = Date.now();
    var clock = el.querySelector(".vr-time");
    var tick = setInterval(function () { clock.textContent = mmss(Date.now() - t0); }, 500);
    var done = false;
    function end() {
      if (done) return false;
      done = true;
      clearInterval(tick);
      document.removeEventListener("keydown", onKey, true);
      return true;
    }
    var ctl = {
      el: el,
      sendButton: el.querySelector("[data-vr-send]"),
      // Removes the rail (send, or a recording that ended by itself).
      close: function () { if (end()) el.remove(); },
      // The mic drops into the bin (CSS), then the rail goes and done() runs.
      discard: function (cb) {
        if (!end()) return;
        el.classList.add("discarding");
        setTimeout(function () { el.remove(); if (cb) cb(); }, 420);
      }
    };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); if (opts.onDiscard) opts.onDiscard(); }
    }
    document.addEventListener("keydown", onKey, true);
    el.querySelector("[data-vr-bin]").addEventListener("click", function () { if (opts.onDiscard) opts.onDiscard(); });
    if (ctl.sendButton) ctl.sendButton.addEventListener("click", function () { if (opts.onSend) opts.onSend(); });
    announce(T.rec);
    return ctl;
  }
  window.WHRail = { open: open, announce: announce, text: T };

  function pickType() {
    var types = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    for (var i = 0; i < types.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    return "";
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-voice-target]");
    if (!btn) return;
    e.preventDefault();
    if (btn._rec) return; // while recording the button is hidden; the rail's send button stops it
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      btn.textContent = btn.getAttribute("data-unsupported") || "Voice is not supported here";
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = pickType();
      var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      var chunks = [];
      var discarded = false;
      var ctl = null;
      btn._rec = rec;
      btn.classList.add("recording");
      btn.hidden = true;
      // A note longer than a minute costs more to read: stop at 60 seconds.
      var cap = setTimeout(function () { if (btn._rec) rec.stop(); }, 60000);
      function finish() {
        clearTimeout(cap);
        btn._rec = null;
        btn.classList.remove("recording");
        btn.hidden = false;
      }
      ctl = open({
        parent: btn.parentNode,
        before: btn,
        send: true,
        onSend: function () { if (btn._rec) rec.stop(); },
        onDiscard: function () {
          if (!btn._rec || discarded) return;
          discarded = true;
          rec.stop();
          ctl.discard(function () { btn.focus(); announce(T.gone); });
        }
      });
      ctl.sendButton.focus();
      rec.ondataavailable = function (ev) { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        finish();
        if (discarded) return;
        ctl.close();
        announce(T.sent);
        var blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
        var form = btn.closest("form");
        var data = new FormData(form);
        data.append("voice", blob, "note");
        var meta = document.querySelector('meta[name="csrf-token"]');
        var target = document.querySelector(btn.getAttribute("data-voice-target"));
        btn.classList.add("busy");
        btn.disabled = true;
        fetch(btn.getAttribute("data-voice-url"), {
          method: "POST",
          body: data,
          credentials: "same-origin",
          headers: { "X-CSRF-Token": meta ? meta.content : "", "HX-Request": "true" }
        })
          .then(function (r) { return r.text(); })
          .then(function (htmlText) {
            btn.classList.remove("busy");
            btn.disabled = false;
            if (target) {
              target.outerHTML = htmlText;
              if (window.htmx) window.htmx.process(document.body);
            }
          })
          .catch(function () { btn.classList.remove("busy"); btn.disabled = false; });
      };
      rec.start();
    });
  });
})();
