// web/static/unitFields.js — The add/edit unit form shows only the fields that fit the unit. Rules sit on the markup:
//   data-show-if="listing_type=rent"   the field shows only when that field has that value (a|b for several)
//   data-hide-if="listing_type=rent"   the section is off when that field has that value (a rental has no delivery or payment)
//   data-show-types="villa,twin_villa" the field shows only for these unit types (and always when it already has a value)
// A hidden field is also disabled, so what it holds is never sent: the saved unit has no rent period for a sale and no
// delivery date or payment plan for a rental (the server enforces the same: web/forms/unitForm.js). A step whose sections are all
// off is skipped by the step bar (app.js stepForm, which listens for "rules:change").
(function () {
  "use strict";

  function valueOf(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : "";
  }
  function matches(form, rule) {
    var at = String(rule).split("=");
    var wanted = (at[1] || "").split("|");
    return wanted.indexOf(valueOf(form, at[0])) >= 0;
  }
  function filled(el) {
    var fields = el.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].type === "hidden" || fields[i].type === "checkbox" || fields[i].type === "radio") continue;
      if (fields[i].value !== "") return true;
    }
    return false;
  }
  // Off: hidden (unless the step bar decides) and its controls disabled; on: back as it was.
  function setOff(form, el, off) {
    var isStep = el.hasAttribute("data-step");
    if (off) el.setAttribute("data-rule-off", ""); else el.removeAttribute("data-rule-off");
    if (!isStep || !form.hasAttribute("data-stepped")) el.hidden = off;
    var fields = el.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) {
      if (off && !fields[i].disabled) { fields[i].disabled = true; fields[i].setAttribute("data-rule-disabled", ""); }
      else if (!off && fields[i].hasAttribute("data-rule-disabled")) { fields[i].disabled = false; fields[i].removeAttribute("data-rule-disabled"); }
    }
  }

  function apply(form) {
    var type = valueOf(form, "property_type");
    var nodes = form.querySelectorAll("[data-show-if], [data-hide-if], [data-show-types]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var off = false;
      if (el.hasAttribute("data-show-if")) off = !matches(form, el.getAttribute("data-show-if"));
      else if (el.hasAttribute("data-hide-if")) off = matches(form, el.getAttribute("data-hide-if"));
      else off = el.getAttribute("data-show-types").split(",").indexOf(type) < 0 && !filled(el);
      setOff(form, el, off);
    }
    // The price is the monthly rent for a rental.
    var price = form.querySelector("[data-label-rent]");
    var text = price && price.parentNode.firstChild;
    if (text && text.nodeType === 3) text.nodeValue = price.getAttribute(valueOf(form, "listing_type") === "rent" ? "data-label-rent" : "data-label-sale");
    // The section links of an edit page follow their sections.
    var links = form.querySelectorAll("[data-step-link]");
    for (var k = 0; k < links.length; k++) {
      var n = links[k].getAttribute("data-step-link");
      var parts = form.querySelectorAll('[data-step="' + n + '"]');
      var alive = false;
      for (var p = 0; p < parts.length; p++) if (!parts[p].hasAttribute("data-rule-off")) alive = true;
      links[k].hidden = !alive;
    }
    form.dispatchEvent(new CustomEvent("rules:change"));
  }

  function init(form) {
    if (!form || form.hasAttribute("data-fields-on")) return;
    form.setAttribute("data-fields-on", "");
    var run = function () { apply(form); };
    form.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.name && (t.name === "listing_type" || t.name === "property_type")) run();
    });
    run();
    // The step bar is built after this script when the page loads: ask it to draw again once it exists.
    setTimeout(run, 0);
  }

  init(document.getElementById("unit-form"));
  // The form comes back whole after "fill from the message" (htmx swap).
  document.addEventListener("htmx:load", function (e) {
    var t = e.target;
    init(t && t.id === "unit-form" ? t : t && t.querySelector && t.querySelector("#unit-form"));
  });
})();
