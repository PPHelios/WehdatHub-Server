const { appBack } = require("../../lib/appBack");

describe("appBack: where a form may send the user back", () => {
  it.each(["/app", "/app/", "/app/units", "/app/units?status=active&old=1", "/app/search?q=a+b"])("allows %s", (p) => {
    expect(appBack(p)).toBe(p);
  });

  it.each(["//evil.example", "/app//evil.example", "https://evil.example/app", "/appx", "/app/units/AP-A1", "javascript:alert(1)", "", undefined])("refuses %p", (p) => {
    expect(appBack(p)).toBeNull();
  });
});
