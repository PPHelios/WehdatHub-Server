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

describe("verdict (Check all)", () => {
  const saved = { lat: 30.0, lng: 31.5 };
  const near = { lat: 30.001, lng: 31.5 };
  const far = { lat: 30.2, lng: 31.5 };
  test("a service within 0.5 km: looks right", () => {
    expect(Lookup.verdict({ saved, osm: near, google: far })).toBe("ok");
    expect(Lookup.verdict({ saved, osm: null, google: near })).toBe("ok");
  });
  test("both services agree on a spot over 1 km away: confident move", () => {
    expect(Lookup.verdict({ saved, osm: far, google: { lat: 30.2005, lng: 31.5 } })).toBe("move");
  });
  test("one service alone, disagreeing services, or nothing found: needs a person", () => {
    expect(Lookup.verdict({ saved, osm: far, google: null })).toBe("review");
    expect(Lookup.verdict({ saved, osm: far, google: { lat: 30.4, lng: 31.5 } })).toBe("review");
    expect(Lookup.verdict({ saved, osm: null, google: null })).toBe("review");
    expect(Lookup.verdict({ saved: null, osm: far, google: far })).toBe("review");
  });
});

describe("Google result rules", () => {
  const place2 = { id: "22222222-2222-4222-8222-222222222222", name_en: "Uptown Cairo", name_ar: null, district: "Mokattam Hills" };
  const hit = (lat, lng, types = ["establishment"], address = "Uptown Cairo, Mokattam, Egypt") => ({ geometry: { location: { lat, lng } }, types, formatted_address: address });
  const fetchWith = (results, seen = []) => async (url) => {
    seen.push(url);
    if (url.includes("nominatim")) return { ok: true, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ status: results.length ? "OK" : "ZERO_RESULTS", results }) };
  };

  test("Google is asked with a country limit, not only a region hint", async () => {
    const seen = [];
    await Lookup.suggest([place2], { fetchFn: fetchWith([hit(30.0086, 31.3267)], seen), key: "k", pauseMs: 0 });
    const gurl = seen.find((u) => u.includes("geocode"));
    expect(gurl).toContain("components=country:EG");
  });

  test("a city or area only answer is not used", async () => {
    const [row] = await Lookup.suggest([place2], { fetchFn: fetchWith([hit(30.0086, 31.3267, ["locality", "political"])]), key: "k", pauseMs: 0 });
    expect(row.google).toBeNull();
    expect(row.google_status).toBe("GENERIC_ONLY");
  });

  test("a precise answer far from the district is rejected", async () => {
    // Mokattam is about 12 km from the centre used for it; a point in New Cairo is about 25 km away.
    const [row] = await Lookup.suggest([place2], { fetchFn: fetchWith([hit(30.0, 31.6)]), key: "k", pauseMs: 0 });
    expect(row.google).toBeNull();
    expect(row.google_status).toBe("OUT_OF_DISTRICT");
  });

  test("a district with no rule is not checked", async () => {
    const other = { id: "33333333-3333-4333-8333-333333333333", name_en: "Mivida", name_ar: null, district: "South 90th" };
    const [row] = await Lookup.suggest([other], { fetchFn: fetchWith([hit(30.0, 31.6)]), key: "k", pauseMs: 0 });
    expect(row.google_status).toBe("OK");
  });

  test("the Downtown default point is not used", async () => {
    const [row] = await Lookup.suggest([place2], { fetchFn: fetchWith([hit(30.04442, 31.235712, ["establishment"], "Qasr el Nil, Cairo, Egypt")]), key: "k", pauseMs: 0 });
    expect(row.google).toBeNull();
  });
});
