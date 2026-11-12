// web/uploads.js — Multipart uploads in memory only (never on disk: Render's disk is ephemeral)
"use strict";

const multer = require("multer");
const { csrfAfterParse, staleToken } = require("./session");

const MB = 1024 * 1024;
// Uploads are held in memory while they are read, so only a few run at once; the rest are told to try again in a moment
// (Render's free plan has 512 MB; 4 uploads of up to 15 photos at 10 MB would otherwise be able to fill it).
const MAX_PARALLEL = Number(process.env.UPLOADS_IN_PARALLEL) > 0 ? Number(process.env.UPLOADS_IN_PARALLEL) : 4;
let active = 0;

/**
 * Express middleware for a set of file fields: [{ name, maxCount, maxMb, accept: RegExp }].
 * Files land in req.files[name] as buffers; a refused or oversized file answers 413/415.
 */
function uploads(fields, { maxMb = 10, fieldSizeKb = 256 } = {}) {
  const accept = Object.fromEntries(fields.map((f) => [f.name, f.accept]));
  const mw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * MB, files: fields.reduce((n, f) => n + f.maxCount, 0), fieldSize: fieldSizeKb * 1024, fields: 300 },
    fileFilter: (_req, file, cb) => {
      const re = accept[file.fieldname];
      if (re && !re.test(file.mimetype)) return cb(Object.assign(new Error(`Unsupported file type ${file.mimetype}`), { code: "UNSUPPORTED_TYPE" }));
      return cb(null, true);
    }
  }).fields(fields.map(({ name, maxCount }) => ({ name, maxCount })));
  return (req, res, next) => {
    if (active >= MAX_PARALLEL) return res.status(503).set("Retry-After", "5").send("Busy with other uploads — try again in a few seconds.");
    active++;
    let freed = false;
    const free = () => {
      if (!freed) {
        freed = true;
        active--;
      }
    };
    res.on("close", free);
    return mw(req, res, (err) => {
      // On success the slot is held until the answer is sent (the photos stay in memory while the handler works on them).
      if (!err) return csrfAfterParse(req) ? next() : staleToken(req, res);
      free();
      const status = err.code === "UNSUPPORTED_TYPE" ? 415 : err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FILE_COUNT" ? 413 : 400;
      return res.status(status).send(err.code === "UNSUPPORTED_TYPE" ? err.message : `Upload refused (${err.code || err.message})`);
    });
  };
}

const PHOTO = { name: "photos", maxCount: 15, accept: /^image\// };
const VOICE = { name: "voice", maxCount: 1, accept: /^(audio|video)\/(ogg|webm|mp4|mpeg|aac|wav|x-wav|x-m4a|m4a)/ };

/** The unit form takes up to 5 voice notes (each is read by the AI and costs its credits). */
const VOICE_MANY = { ...VOICE, maxCount: 5 };

module.exports = { MB, uploads, PHOTO, VOICE, VOICE_MANY };
