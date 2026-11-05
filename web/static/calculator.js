// web/static/calculator.js — The payment calculator updates in place when an input changes: the form's values are
// sent as JSON and the result figures are replaced, so the page does not reload. Without script the form still works.
(function () {
  var form = document.querySelector("form[data-calc]");
  if (!form || !window.fetch) return;
  function set(name, value) {
    var el = document.querySelector('[data-out="' + name + '"]');
    if (el) el.textContent = value;
  }
  function money(n) {
    return Math.round(Number(n) || 0).toLocaleString(document.documentElement.lang === "en" ? "en-US" : "ar-EG");
  }
  form.addEventListener("change", function () {
    var params = new URLSearchParams(new FormData(form));
    params.set("format", "json");
    fetch(form.action + "?" + params.toString(), { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        set("down_payment", money(d.down_payment));
        set("installment", money(d.installment));
        set("installments", d.installments);
        set("extra", money(d.extra));
        var w = document.querySelector('[data-out="warning"]');
        if (w) w.style.display = d.exception ? "" : "none";
      })
      .catch(function () { form.requestSubmit ? form.requestSubmit() : form.submit(); });
  });
})();
