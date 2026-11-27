// tests/unit/assistant-paraphrase.test.js — reworded everyday questions must hit the right route (fixture: tests/fixtures/assistant-questions.json).
"use strict";

const Router = require("../../domain/assistantRouter");
const Search = require("../../domain/searchQuery");
const fx = require("../fixtures/assistant-questions.json");

const NOW = new Date("2026-11-25T10:00:00Z");
const route = (text) => Router.classifyAssistantQuery({ text, mode: "auto", now: NOW });

describe("assistant paraphrases", () => {
  for (const intent of fx.intents) {
    test.each(intent.questions)(`${intent.id}: %s`, (q) => {
      const r = route(q);
      const { windowKey, ...rest } = intent.expect;
      expect(r).toMatchObject(rest);
      if (windowKey) expect(r.windowInfo?.key).toBe(windowKey);
    });
  }

  test.each(fx.offTopic)("off topic: %s", (q) => {
    expect(route(q).route).toBe("clarify");
  });

  test.each(fx.unitSearches.map((u) => [u.q, u.expect]))("unit search: %s", (q, expected) => {
    expect(route(q).route).toBe("unit_search");
    expect(Search.fallbackParse(q).filters).toMatchObject(expected);
  });
});

describe("safety: CRM wording never becomes a property list", () => {
  const CRM = ["client", "lead", "عميل", "عملاء", "ليدز", "متابعة", "follow up", "بروكر", "broker", "وسيط", "سيلز", "team", "فريق", "report", "تقرير", "ملخص", "deal", "صفقة", "عمولة", "مصدر", "source"];
  const FRAMES = [(w) => `${w}`, (w) => `ايه اخبار ${w} النهارده`, (w) => `show me the ${w} thing`, (w) => `عايز اعرف ${w} الاسبوع ده`, (w) => `بقولك ايه هو انا عندي ${w} كتير`];
  const cases = CRM.flatMap((w) => FRAMES.map((f) => f(w)));
  test.each(cases)("%s", (q) => {
    expect(route(q).route).not.toBe("unit_search");
  });

  test("every fixture CRM question avoids unit_search", () => {
    for (const i of fx.intents.filter((x) => x.expect.route.startsWith("crm_"))) {
      for (const q of i.questions) expect(route(q).route).not.toBe("unit_search");
    }
  });

  test("property words still search", () => {
    for (const q of ["شقة لعميل في التجمع", "my client wants a villa", "عميلي عايز شقة 3 غرف", "client budget 5 million"]) {
      expect(route(q).route).not.toBe("clarify");
    }
  });
});
