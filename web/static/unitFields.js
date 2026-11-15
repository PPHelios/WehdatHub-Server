// web/static/unitFields.js — The add/edit unit form shows only the fields that fit the unit. Rules sit on the markup:
//   data-show-if="listing_type=rent"   the field shows only when that field has that value (a|b for several)
//   data-hide-if="listing_type=rent"   the section is off when that field has that value (a rental has no delivery or payment)
//   data-show-types="villa,twin_villa" the field shows only for these unit types (and always when it already has a value)
// The description for clients (textarea[data-draft]) is written from the unit's own fields while it is empty or still the draft;
// once someone edits it by hand it stays theirs, and the "write it again" button (data-draft-again) takes it back.
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

  // ---- the description for clients, written from the form ----
  function num(form, name) { var v = Number(valueOf(form, name)); return v > 0 ? v : 0; }
  function chosenText(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el && el.value && el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : "";
  }
  function draftText(form, en) {
    var type = chosenText(form, "property_type");
    var rent = valueOf(form, "listing_type") === "rent";
    var sale = valueOf(form, "listing_type") === "sale";
    var placeEl = form.querySelector('[data-ubox-chip="place"] [data-chip-text]');
    var place = placeEl ? placeEl.textContent.trim() : "";
    var head = [type, rent ? (en ? "for rent" : "للإيجار") : sale ? (en ? "for sale" : "للبيع") : ""].filter(Boolean).join(" ");
    if (head && place) head += (en ? " in " : " في ") + place;
    var parts = [];
    var area = num(form, "area_value"), beds = num(form, "bedrooms"), baths = num(form, "bathrooms");
    if (area) parts.push(en ? area + " m²" : "مساحة " + area + " م²");
    if (num(form, "land_area")) parts.push(en ? "land " + num(form, "land_area") + " m²" : "أرض " + num(form, "land_area") + " م²");
    if (beds) parts.push(en ? beds + (beds === 1 ? " bedroom" : " bedrooms") : beds + (beds > 10 ? " غرفة" : beds > 2 ? " غرف نوم" : beds === 2 ? " غرفتين نوم" : " غرفة نوم"));
    if (baths) parts.push(en ? baths + (baths === 1 ? " bathroom" : " bathrooms") : baths + (baths > 10 ? " حمام" : baths > 2 ? " حمامات" : baths === 2 ? " حمامين" : " حمام"));
    var floor = valueOf(form, "floor_level");
    if (floor !== "" && !isNaN(Number(floor))) parts.push(Number(floor) === 0 ? (en ? "ground floor" : "الدور الأرضي") : (en ? "floor " : "الدور ") + Number(floor));
    if (num(form, "garden_area")) parts.push(en ? "garden " + num(form, "garden_area") + " m²" : "جنينة " + num(form, "garden_area") + " م²");
    if (num(form, "roof_area")) parts.push(en ? "roof " + num(form, "roof_area") + " m²" : "روف " + num(form, "roof_area") + " م²");
    var fin = chosenText(form, "finishing");
    if (fin) parts.push(en ? fin + " finishing" : "تشطيب " + fin);
    var furn = chosenText(form, "furnishing");
    if (furn) parts.push(furn);
    if (sale) {
      var ready = form.querySelector('[name="is_ready"]');
      var year = valueOf(form, "delivery_year");
      if (ready && ready.checked) parts.push(en ? "ready to move" : "استلام فوري");
      else if (year) parts.push(en ? "delivery " + year : "تسليم " + year);
    }
    var feats = Array.prototype.map.call(form.querySelectorAll('[data-ubox-chip="feature"] [data-chip-text]'), function (t) { return t.textContent.trim(); });
    var out = head;
    if (parts.length) out += (out ? ". " : "") + parts.join(en ? ", " : "، ");
    if (feats.length) out += (out ? ". " : "") + feats.join(en ? ", " : "، ");
    return out ? out + "." : "";
  }
  function initDraft(form) {
    var box = form.querySelector("textarea[data-draft]");
    if (!box) return;
    var en = box.getAttribute("data-draft") === "en";
    var auto = box.value.trim() === "";
    var write = function () { if (auto) box.value = draftText(form, en); };
    box.addEventListener("input", function () { auto = box.value.trim() === ""; });
    var again = form.querySelector("[data-draft-again]");
    if (again) again.addEventListener("click", function () { auto = true; write(); box.focus(); });
    form.addEventListener("change", write);
    form.addEventListener("input", function (e) { if (e.target !== box) write(); });
    form.addEventListener("rules:change", write);
    write();
  }

  function init(form) {
    if (!form || form.hasAttribute("data-fields-on")) return;
    form.setAttribute("data-fields-on", "");
    var run = function () { apply(form); };
    form.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.name && (t.name === "listing_type" || t.name === "property_type")) run();
    });
    initDraft(form);
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
