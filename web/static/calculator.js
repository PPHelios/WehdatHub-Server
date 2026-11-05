// web/static/calculator.js — The payment calculator submits its form when an input changes, so the results update at once.
(function () {
  var form = document.querySelector("form[data-calc]");
  if (!form) return;
  form.addEventListener("change", function () {
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  });
})();
