"use strict";
const { isPrivateIp } = require("../../lib/flyerAssets");

test("private, loopback, CGNAT and mapped addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.1", "0.0.0.0", "::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1"]) {
    expect([ip, isPrivateIp(ip)]).toEqual([ip, true]);
  }
});

test("public addresses pass", () => {
  for (const ip of ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:808:808"]) {
    expect([ip, isPrivateIp(ip)]).toEqual([ip, false]);
  }
});
