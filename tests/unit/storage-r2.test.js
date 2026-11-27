// tests/unit/storage-r2.test.js — lib/supabase.js on Cloudflare R2 (R2_* set): links, old Supabase links, presigned PUT,
// uploads and chunked deletes. The network is a fake fetch; nothing leaves the machine.
"use strict";

const R2_ENV = {
  R2_ACCOUNT_ID: "acc123",
  R2_ACCESS_KEY_ID: "AKIDTEST",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "media",
  R2_PUBLIC_URL: "https://media.example.com/",
  SUPABASE_URL: "https://proj.supabase.co"
};

let Storage;
let calls;
const realFetch = global.fetch;

beforeEach(() => {
  Object.assign(process.env, R2_ENV);
  calls = [];
  global.fetch = jest.fn(async (req) => {
    const url = typeof req === "string" ? req : req.url;
    calls.push({ url, method: req.method, headers: req.headers, body: req.method === "POST" ? await req.text() : null });
    return new Response("<DeleteResult></DeleteResult>", { status: 200 });
  });
  jest.isolateModules(() => {
    Storage = require("../../lib/supabase");
  });
});

afterEach(() => {
  for (const k of Object.keys(R2_ENV)) delete process.env[k];
  delete process.env.R2_JURISDICTION;
  global.fetch = realFetch;
});

test("photoUrl builds the R2 public link from a key, keeps other https links, rewrites old Supabase bucket links", () => {
  expect(Storage.photoUrl("listings/a 1/x.jpg")).toBe("https://media.example.com/listings/a%201/x.jpg");
  expect(Storage.thumbUrl("listings/a/x.jpg")).toBe("https://media.example.com/thumbs/listings/a/x.jpg");
  expect(Storage.photoUrl("https://cdn.other.com/p.jpg")).toBe("https://cdn.other.com/p.jpg");
  expect(Storage.photoUrl("https://proj.supabase.co/storage/v1/object/public/listing-images/listings/a/x.jpg")).toBe("https://media.example.com/listings/a/x.jpg");
});

test("createSignedUpload is a presigned PUT on the S3 endpoint, valid 2 hours, signing only the host", async () => {
  const url = new URL(await Storage.createSignedUpload("listings/a/x.jpg"));
  expect(url.origin + url.pathname).toBe("https://acc123.r2.cloudflarestorage.com/media/listings/a/x.jpg");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIDTEST\/\d{8}\/auto\/s3\/aws4_request$/);
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
});

test("R2_JURISDICTION=eu uses the EU endpoint", async () => {
  process.env.R2_JURISDICTION = "eu";
  jest.isolateModules(() => {
    Storage = require("../../lib/supabase");
  });
  expect(await Storage.createSignedUpload("k.jpg")).toMatch(/^https:\/\/acc123\.eu\.r2\.cloudflarestorage\.com\/media\/k\.jpg\?/);
});

test("photo uploads never overwrite (If-None-Match); flyers overwrite; both are cached a year", async () => {
  await Storage.uploadFlyerImage("ag", "flyers/f.jpg", Buffer.from("f"));
  const put = calls.find((c) => c.method === "PUT");
  expect(put.url).toBe("https://acc123.r2.cloudflarestorage.com/media/flyers/f.jpg");
  expect(put.headers.get("content-type")).toBe("image/jpeg");
  expect(put.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(put.headers.get("if-none-match")).toBeNull();
  expect(put.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);

  calls = [];
  await Storage.uploadProjectFile("ag", "p/doc.pdf", Buffer.from("x"), "application/pdf");
  expect(calls[0].headers.get("if-none-match")).toBe("*");
  expect(calls[0].headers.get("content-type")).toBe("application/pdf");
});

test("a refused upload (412: already there) is a failure, like Supabase's duplicate error", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = jest.fn(async () => new Response("", { status: 412 }));
  expect(await Storage.uploadProjectFile("ag", "p/doc.pdf", Buffer.from("x"), "application/pdf")).toBeNull();
  console.error.mockRestore();
});

test("deleteStorageFiles sends DeleteObjects in chunks of 1000, keys escaped, old links reduced to keys", async () => {
  const paths = Array.from({ length: 2001 }, (_, i) => `listings/a/${i}.jpg`);
  paths[0] = "https://proj.supabase.co/storage/v1/object/public/listing-images/listings/a/<&>.jpg";
  expect(await Storage.deleteStorageFiles(paths)).toBe(true);
  expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
  expect(calls[0].url).toBe("https://acc123.r2.cloudflarestorage.com/media?delete");
  expect(calls.map((c) => (c.body.match(/<Object>/g) || []).length)).toEqual([1000, 1000, 1]);
  expect(calls[0].body).toContain("<Key>listings/a/&#60;&#38;&#62;.jpg</Key>");
  expect(calls[0].headers.get("content-md5")).toMatch(/==$/);
});

test("a delete answer with an <Error> entry is a failure", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = jest.fn(async () => new Response("<DeleteResult><Error><Key>k</Key></Error></DeleteResult>", { status: 200 }));
  expect(await Storage.deleteStorageFiles(["listings/a/1.jpg"])).toBe(false);
  console.error.mockRestore();
});

test("downloadListingImage only fetches under the R2 public prefix", async () => {
  global.fetch = jest.fn(async () => new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/jpeg" } }));
  expect((await Storage.downloadListingImage("listings/a/x.jpg")).buffer.toString()).toBe("img");
  expect(await Storage.downloadListingImage("https://evil.example.com/x.jpg")).toBeNull();
  expect(await Storage.downloadListingImage("listings/../x.jpg")).toBeNull();
});
