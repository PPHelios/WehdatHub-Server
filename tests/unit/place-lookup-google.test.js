"use strict";

const Lookup = require("../../services/placeLookup");

const place = { id: "11111111-1111-4111-8111-111111111111", name_en: "Amwaj", name_ar: null };

// OpenStreetMap finds nothing; Google answers with the given body.
function fakeFetch(googleBody, { httpOk = true, status = 200 } = {}) {
  return async (url) => {
    if (url.includes("nominatim")) return { ok: true, json: async () => [] };
    return { ok: httpOk, status, json: async () => googleBody };
  };
}

test("no key: Google is not called and the status says no key", async () => {
  const [row] = await Lookup.suggest([place], { fetchFn: fakeFetch({}), key: "", pauseMs: 0 });
  expect(row.google_status).toBe("no_key");
  expect(row.source).toBeNull();
});

test("ZERO_RESULTS is reported as a no-match, not a key problem", async () => {
  const [row] = await Lookup.suggest([place], { fetchFn: fakeFetch({ status: "ZERO_RESULTS" }), key: "k", pauseMs: 0 });
  expect(row.google_status).toBe("ZERO_RESULTS");
  expect(row.google).toBeNull();
});

test("REQUEST_DENIED is kept so a rejected key can be seen", async () => {
  const [row] = await Lookup.suggest([place], { fetchFn: fakeFetch({ status: "REQUEST_DENIED" }), key: "k", pauseMs: 0 });
  expect(row.google_status).toBe("REQUEST_DENIED");
});

test("HTTP errors keep their code", async () => {
  const [row] = await Lookup.suggest([place], { fetchFn: fakeFetch({}, { httpOk: false, status: 403 }), key: "k", pauseMs: 0 });
  expect(row.google_status).toBe("HTTP_403");
});

test("a Google hit inside Egypt is used as the fallback", async () => {
  const body = { status: "OK", results: [{ geometry: { location: { lat: 30.9, lng: 28.6 } } }] };
  const [row] = await Lookup.suggest([place], { fetchFn: fakeFetch(body), key: "k", pauseMs: 0 });
  expect(row.google_status).toBe("OK");
  expect(row.source).toBe("google");
});
