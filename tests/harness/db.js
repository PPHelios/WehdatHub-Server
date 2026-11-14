// tests/harness/db.js — In-process Postgres (PGlite) behind a pg.Pool-compatible adapter
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runMigrations } = require("../../lib/migrate");

const SCHEMA_PATH = path.join(__dirname, "..", "..", "db", "schema.sql");
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "db", "migrations");

// Building the database (schema plus every migration) takes about 4 seconds, and every test file needs one. The first file
// builds it and saves a copy; later files (and parallel workers) load that copy. The copy's name comes from the schema,
// every migration and the PGlite version, so any change to them builds a fresh one. TEST_DB_SNAPSHOT=0 turns this off.
function snapshotPath() {
  const h = crypto.createHash("sha256");
  h.update(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "node_modules", "@electric-sql", "pglite", "package.json"), "utf8")).version);
  h.update(fs.readFileSync(SCHEMA_PATH));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    h.update(f);
    h.update(fs.readFileSync(path.join(MIGRATIONS_DIR, f)));
  }
  return path.join(os.tmpdir(), `wehdathub-testdb-${h.digest("hex").slice(0, 16)}.tgz`);
}

// lib/db.js parses NUMERIC and INT8 into numbers; mirror that so tests see production types.
const PG_COMPAT_PARSERS = {
  1700: (v) => (v === null ? null : Number(v)), // numeric
  20: (v) => (v === null ? null : Number(v)) // int8
};

/**
 * Creates a fresh database loaded with db/schema.sql plus db/migrations and returns a pg.Pool-like object.
 * PGlite has a single connection, so the adapter serializes transactions: while a client
 * holds an open transaction, pool.query calls wait until it commits or rolls back.
 */
async function createTestDb({ migrate = true, snapshot = true } = {}) {
  // CommonJS builds: Jest cannot import() ESM without experimental VM flags.
  const { PGlite } = require("@electric-sql/pglite");
  const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
  const { uuid_ossp } = require("@electric-sql/pglite/contrib/uuid_ossp");

  // snapshot: false for a test that dumps its own database (a loaded copy cannot be dumped again in PGlite 0.5).
  const useSnapshot = migrate && snapshot && process.env.TEST_DB_SNAPSHOT !== "0";
  const snap = useSnapshot ? snapshotPath() : null;
  let copy = null;
  if (snap && fs.existsSync(snap)) {
    try { copy = new Blob([fs.readFileSync(snap)]); } catch { copy = null; }
  }
  const db = new PGlite({
    extensions: { pg_trgm, pgcrypto, uuid_ossp },
    parsers: PG_COMPAT_PARSERS,
    ...(copy ? { loadDataDir: copy } : {})
  });
  if (!copy) await db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  let txOwner = null; // client currently inside BEGIN … COMMIT/ROLLBACK
  let txDone = Promise.resolve();
  let releaseTx = () => {};

  const toResult = (r) => ({
    rows: r.rows,
    rowCount: r.affectedRows ?? r.rows.length,
    fields: r.fields
  });

  async function run(text, params) {
    // Multi-statement text without params goes through exec (simple protocol).
    if (!params || params.length === 0) {
      const results = await db.exec(text);
      return toResult(results[results.length - 1] || { rows: [] });
    }
    return toResult(await db.query(text, params));
  }

  async function waitForTx(caller) {
    const started = Date.now();
    while (txOwner && txOwner !== caller) {
      await Promise.race([txDone, new Promise((r) => setTimeout(r, 50))]);
      if (Date.now() - started > 5000) {
        throw new Error(
          "Test DB deadlock: query waited >5s for another client's open transaction"
        );
      }
    }
  }

  function makeClient() {
    const client = {
      async query(text, params) {
        const sql = typeof text === "string" ? text : text.text;
        const values = typeof text === "string" ? params : text.values;
        const verb = sql.trim().split(/\s+/)[0].toUpperCase();
        if (verb === "BEGIN" || verb === "START") {
          await waitForTx(client);
          txOwner = client;
          txDone = new Promise((r) => (releaseTx = r));
        } else {
          await waitForTx(client);
        }
        try {
          return await run(sql, values);
        } finally {
          if ((verb === "COMMIT" || verb === "ROLLBACK" || verb === "END") && txOwner === client) {
            txOwner = null;
            releaseTx();
          }
        }
      },
      release() {
        if (txOwner === client) {
          // Mirror pg: releasing a client mid-transaction must not leak the open transaction.
          txOwner = null;
          releaseTx();
          return db.exec("ROLLBACK").catch(() => {});
        }
      }
    };
    return client;
  }

  const pool = {
    query: (text, params) => makeClient().query(text, params),
    connect: async () => makeClient(),
    end: async () => db.close(),
    on: () => {}
  };

  // On a loaded copy every migration is already recorded, so this only confirms nothing is missing.
  if (migrate) await runMigrations(pool);
  if (snap && !copy) {
    try {
      const dump = Buffer.from(await (await db.dumpDataDir("gzip")).arrayBuffer());
      const tmp = `${snap}.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, dump);
      fs.renameSync(tmp, snap); // atomic: a parallel worker never reads half a file
    } catch {
      /* no copy saved: the next file builds its own */
    }
  }
  return { pool, db };
}

module.exports = { createTestDb, SCHEMA_PATH };
