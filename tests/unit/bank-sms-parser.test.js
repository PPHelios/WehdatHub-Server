// tests/unit/bank-sms-parser.test.js
"use strict";

const assert = require("node:assert");
const { parseBankSms } = require("../../services/bankSmsParser");

test("parseBankSms: extracts Arabic CIB InstaPay alert", () => {
  const sms = "تم استلام تحويل لحظي بمبلغ 1,990.00 جم في حسابك 1234**** عبر إنستاباي. ملاحظات: WH-7K2X9. الرصيد المتاح: 50,000";
  const res = parseBankSms(sms);
  assert.strictEqual(res.reference, "WH-7K2X9");
  assert.strictEqual(res.amount, 1990);
  assert.strictEqual(res.isBankSms, true);
  assert.strictEqual(res.incoming, true);
});

test("parseBankSms: extracts English QNB InstaPay alert", () => {
  const sms = "Inward IPN transfer of EGP 599.00 credited to your account. Remarks: WH-AB12CD.";
  const res = parseBankSms(sms);
  assert.strictEqual(res.reference, "WH-AB12CD");
  assert.strictEqual(res.amount, 599);
  assert.strictEqual(res.isBankSms, true);
});

test("parseBankSms: handles missing reference but recognizes deposit", () => {
  const sms = "تم استلام تحويل بمبلغ 1075 جم عبر إنستاباي من أحمد علي";
  const res = parseBankSms(sms);
  assert.strictEqual(res.reference, null);
  assert.strictEqual(res.amount, 1075);
  assert.strictEqual(res.isBankSms, true);
});

test("parseBankSms: ignores non-banking spam", () => {
  const sms = "Hello, your order is ready for pickup.";
  const res = parseBankSms(sms);
  assert.strictEqual(res.reference, null);
  assert.strictEqual(res.amount, null);
  assert.strictEqual(res.isBankSms, false);
});

test("outgoing and failed transfers cannot confirm a payment", () => {
  assert.strictEqual(parseBankSms("Transfer sent for EGP 599. WH-AB12CD").incoming, false);
  assert.strictEqual(parseBankSms("Transfer failed before funds were credited. EGP 599. WH-AB12CD").incoming, false);
});

test("an available balance is never used as the deposit amount", () => {
  expect(parseBankSms("Transfer credited. WH-AB12CD. Available balance EGP 599.").amount).toBeNull();
});
