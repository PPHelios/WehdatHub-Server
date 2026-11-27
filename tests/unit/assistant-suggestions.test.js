// tests/unit/assistant-suggestions.test.js — follow-up chips are routable, role-safe and never empty; off-topic never swallows real queries.
"use strict";

const Router = require("../../domain/assistantRouter");
const S = require("../../domain/assistantSuggestions");

const route = (text, extra = {}) => Router.classifyAssistantQuery({ text, mode: "auto", ...extra });
const INTENTS = [...Object.keys(S.NEXT), "clarify", "disambiguate", "unknown_intent"];

describe("suggestionsFor", () => {
  test.each(INTENTS.flatMap((i) => S.ROLES.flatMap((r) => ["ar", "en"].flatMap((l) => [false, true].map((solo) => [i, r, l, solo])))))(
    "%s / %s / %s / solo=%s gives 1-3 routable, role-safe chips",
    (intent, role, lang, solo) => {
      const out = S.suggestionsFor({ intent, role, lang, solo });
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(3);
      for (const s of out) {
        const r = route(s.q);
        expect(s.label).toBeTruthy();
        expect(r.route).not.toBe("clarify");
        if (role === "data_entry") expect(r.route).toBe("unit_search");
        if (solo) expect(["crm_stuck_brokers", "crm_response_time", "crm_discipline"]).not.toContain(r.route);
        if (solo) expect(s.q).not.toMatch(/unassigned|من غير وسيط/);
      }
    }
  );

  test("unit search with no results offers wider paths; cheapest reuses the original query", () => {
    expect(S.suggestionsFor({ intent: "unit_search", kind: "none", role: "broker", lang: "en" })[0].q).toBe("new projects");
    const [c] = S.suggestionsFor({ intent: "unit_search", role: "broker", lang: "en", context: { originalQuery: "villa in Sheikh Zayed" } });
    expect(c.q).toBe("villa in Sheikh Zayed cheapest first");
    expect(route(c.q).route).toBe("unit_search");
  });
});

describe("off-topic routing", () => {
  const off = [
    "what's the weather today", "weather forecast tomorrow", "who won the football match", "tell me a joke", "a recipe for koshary",
    "prayer times in Cairo", "latest news", "hi", "hello there", "good morning", "thanks",
    "الطقس النهارده ايه", "نتيجة ماتش الاهلي", "قولي نكتة", "وصفة محشي", "مواقيت الصلاة", "اخبار مصر", "ازيك", "ازيك يا باشا؟", "السلام عليكم", "صباح الخير", "شكرا"
  ];
  const real = [
    "شقة قريبة من النادي", "فيلا في الساحل", "شقة في الزمالك", "villa near the football club", "apartment next to the weather station road",
    "شقه ٣ غرف في التجمع", "3 bedroom apartment in New Cairo", "who is not updating the app", "ايه اخبار الشركة", "اخبار سارة",
    "new projects", "when does Badya deliver?", "كام شقة متاحة", "leads waiting over 1h", "نكتب الملاحظات", "hi villa in sahel", "ملخص النهارده", "today's summary"
  ];
  test.each(off)("off_topic: %s", (t) => expect(route(t)).toMatchObject({ route: "clarify", clarifyKind: "off_topic" }));
  test.each(real)("real query: %s", (t) => expect(route(t).clarifyKind).not.toBe("off_topic"));
});
