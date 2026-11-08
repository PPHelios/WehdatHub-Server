"use strict";

const C = require("../../domain/projectClarify");

const OK = "يونت 110 م سعرها = 3,000,000";
const UNREAD = "كراج 2,500,000 جنيه";

describe("questions about the notes", () => {
  test("a readable offer raises no question", () => {
    expect(C.findIssues(OK)).toEqual([]);
  });

  test("a line with a price that cannot be read is asked about", () => {
    const [q] = C.findIssues(`${OK}\n${UNREAD}`);
    expect(q).toMatchObject({ kind: "unread", line: UNREAD });
    expect(q.question.en).toContain(UNREAD);
  });

  test("two prices for the same unit are a conflict", () => {
    const issues = C.findIssues(`${OK}\nيونت 110 م سعرها = 3,200,000`);
    expect(issues.map((i) => i.kind)).toEqual(["conflict"]);
  });

  test("an answered line is not asked again, and at most 5 questions are asked", () => {
    const answered = `${UNREAD}\n${C.answerLine("2026-11-08", UNREAD, "جراج 2.5 مليون")}`;
    expect(C.findIssues(answered)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `بند ${i} 2,${i}00,000`).join("\n");
    expect(C.findIssues(many)).toHaveLength(C.MAX_QUESTIONS);
  });
});
