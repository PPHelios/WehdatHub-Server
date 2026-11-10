// tests/unit/demoLogin.test.js — Store-review demo sign-in: the fixed code works only for the demo broker in the demo
// agency, and only while DEMO_LOGIN_ENABLED is "true". Every other broker or code keeps the normal code check.
"use strict";

const WebAuth = require("../../lib/webAuth");

const ENV = {
  DEMO_LOGIN_ENABLED: "true",
  DEMO_LOGIN_PHONE: "201044556666",
  DEMO_LOGIN_CODE: "775544",
  DEMO_LOGIN_AGENCY_ID: "a0000000-0000-0000-0000-000000000001"
};
const DEMO = { agency_id: ENV.DEMO_LOGIN_AGENCY_ID, phone_normalized: ENV.DEMO_LOGIN_PHONE };

describe("demoLoginAccepted", () => {
  test("accepts the fixed code for the demo broker in the demo agency", () => {
    expect(WebAuth.demoLoginAccepted(ENV, DEMO, "775544")).toBe(true);
  });

  test("refuses a wrong code", () => {
    expect(WebAuth.demoLoginAccepted(ENV, DEMO, "775545")).toBe(false);
    expect(WebAuth.demoLoginAccepted(ENV, DEMO, "")).toBe(false);
  });

  test("refuses any other broker, even with the right code", () => {
    expect(WebAuth.demoLoginAccepted(ENV, { ...DEMO, phone_normalized: "201055881114" }, "775544")).toBe(false);
  });

  test("refuses the demo phone in any other agency", () => {
    expect(WebAuth.demoLoginAccepted(ENV, { ...DEMO, agency_id: "a4ef889b-76cd-45f6-9d2e-5f8fbf260b49" }, "775544")).toBe(false);
  });

  test("is off unless DEMO_LOGIN_ENABLED is exactly true", () => {
    expect(WebAuth.demoLoginAccepted({ ...ENV, DEMO_LOGIN_ENABLED: "false" }, DEMO, "775544")).toBe(false);
    expect(WebAuth.demoLoginAccepted({ ...ENV, DEMO_LOGIN_ENABLED: undefined }, DEMO, "775544")).toBe(false);
  });

  test("is off when any demo setting is missing", () => {
    expect(WebAuth.demoLoginAccepted({ ...ENV, DEMO_LOGIN_CODE: "" }, DEMO, "775544")).toBe(false);
    expect(WebAuth.demoLoginAccepted({ ...ENV, DEMO_LOGIN_PHONE: undefined }, DEMO, "775544")).toBe(false);
    expect(WebAuth.demoLoginAccepted({ ...ENV, DEMO_LOGIN_AGENCY_ID: undefined }, DEMO, "775544")).toBe(false);
  });

  test("refuses when there is no broker", () => {
    expect(WebAuth.demoLoginAccepted(ENV, null, "775544")).toBe(false);
  });
});
