"use strict";

jest.mock("../../services/billing", () => ({ paymentChannels: jest.fn(), confirmPayment: jest.fn() }));
jest.mock("../../services/billingNotices", () => ({ paymentConfirmed: jest.fn().mockResolvedValue() }));
jest.mock("../../lib/errorReports", () => ({ alertOwner: jest.fn().mockResolvedValue(true) }));

const Billing = require("../../services/billing");
const ErrorReports = require("../../lib/errorReports");
const { register } = require("../../api/bankSmsWebhook");

let handle;
const pool = { query: jest.fn() };
const previousSecret = process.env.BANK_WEBHOOK_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BANK_WEBHOOK_SECRET = "fixture-relay-secret";
  Billing.paymentChannels.mockResolvedValue({ sms: true, telegram: false });
  Billing.confirmPayment.mockResolvedValue({ ok: true });
  pool.query.mockResolvedValue({ rows: [{ id: 1, agency_name: "Fixture Office", status: "pending", amount_egp: 599 }] });
  register({ post: (_path, fn) => { handle = fn; } }, { pool });
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.BANK_WEBHOOK_SECRET;
  else process.env.BANK_WEBHOOK_SECRET = previousSecret;
});

async function send(message, secret = process.env.BANK_WEBHOOK_SECRET) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handle({ get: () => secret, body: { sender: "Fixture Bank", message } }, res);
  return res;
}

test("rejects unauthenticated alerts and fails closed without a configured secret", async () => {
  expect((await send("EGP 599 credited", "incorrect")).status).toHaveBeenCalledWith(401);
  delete process.env.BANK_WEBHOOK_SECRET;
  expect((await send("EGP 599 credited")).status).toHaveBeenCalledWith(503);
  expect(ErrorReports.alertOwner).not.toHaveBeenCalled();
  expect(Billing.confirmPayment).not.toHaveBeenCalled();
});

test.each(["EGP 1 credited. WH-AB12CD", "Transfer sent for EGP 599. WH-AB12CD", "Unmatched alert"])(
  "forwards %s for review without confirming",
  async (message) => {
    await send(message);
    expect(ErrorReports.alertOwner).toHaveBeenCalledWith(expect.stringContaining(message), expect.anything());
    expect(Billing.confirmPayment).not.toHaveBeenCalled();
  }
);

test("forwards and confirms an exact incoming payment with manual Telegram approval switched off", async () => {
  const res = await send("EGP 599 credited. WH-AB12CD");
  expect(ErrorReports.alertOwner).toHaveBeenCalledWith(expect.stringContaining("Fixture Office"), expect.anything());
  expect(Billing.confirmPayment).toHaveBeenCalledWith(pool, 1);
  expect(res.json).toHaveBeenCalledWith({ ok: true, matched: true, payment: "WH-AB12CD" });
});
