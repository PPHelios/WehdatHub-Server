// tests/unit/assistantFeedback.test.js — the scrub applied to a question before it is stored as an assistant miss.
"use strict";

const { scrubQuestion } = require("../../domain/assistantFeedback");

test("phone-like digit runs become #", () => {
  expect(scrubQuestion("call 01012345678 now")).toBe("call # now");
  expect(scrubQuestion("+20 101 234 5678 please")).toBe("# please");
  expect(scrubQuestion("كلم ٠١٠١٢٣٤٥٦٧٨ بكره")).toBe("كلم # بكره");
  expect(scrubQuestion("010-1234-5678")).toBe("#");
});

test("emails become @, short numbers stay", () => {
  expect(scrubQuestion("mail a.b@x.com about 3 bedrooms")).toBe("mail @ about 3 bedrooms");
  expect(scrubQuestion("unit 120 m 3 rooms")).toBe("unit 120 m 3 rooms");
});

test("capped at 200 characters", () => {
  expect(scrubQuestion("a".repeat(500))).toHaveLength(200);
  expect(scrubQuestion(null)).toBe("");
});

test("prices and long non-phone numbers stay", () => {
  expect(scrubQuestion("units under 9000000 in new cairo")).toBe("units under 9000000 in new cairo");
  expect(scrubQuestion("budget 12,500,000 or 1234567")).toBe("budget 12,500,000 or 1234567");
  expect(scrubQuestion("call 00201012345678 or 201012345678")).toBe("call # or #");
});
