import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { httpError } from './http.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const TMP_DIR = path.join(UPLOAD_DIR, '_tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Extension is derived from the (checked) MIME type rather than the client's
// file name, so an upload can never be stored -- and later served -- as .html/.svg.
const IMAGE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
};

const sanitize = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

// Uploads land in a private temp folder first. Nothing user-controlled is used
// to build a path until the request has been authorized; the handler then
// moves the file into place with storeUpload().
export function makeUploader({ maxBytes, imagesOnly = false }) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const original = path.parse(file.originalname || 'upload');
      const base = sanitize(original.name).slice(0, 80) || 'upload';
      const ext = imagesOnly ? IMAGE_EXT[file.mimetype] : sanitize(original.ext).slice(0, 16);
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}-${base}${ext}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter: (req, file, cb) => {
      if (imagesOnly && !IMAGE_EXT[file.mimetype]) {
        return cb(httpError(400, 'Only JPEG, PNG, GIF, WebP, HEIC or AVIF images are allowed'));
      }
      cb(null, true);
    },
  });
}

// Put right after the multer middleware: if the request ends without the file
// having been stored (access denied, validation error, client abort) the temp
// file is deleted instead of being left orphaned on disk.
export function discardUploadUnlessStored(req, res, next) {
  const discard = () => {
    if (req.file && !req.file.stored) fs.rmSync(req.file.path, { force: true });
  };
  // Clean up before the response is flushed so the file is already gone by the
  // time the client sees the error; 'close' covers aborted connections.
  const end = res.end;
  res.end = function patchedEnd(...args) {
    discard();
    return end.apply(this, args);
  };
  res.on('close', discard);
  next();
}

// Moves a temp upload to UPLOAD_DIR/<subdirs...>/. Callers must pass
// server-derived values (validated numeric ids), never raw client input.
export function storeUpload(file, ...subdirs) {
  const dir = path.join(UPLOAD_DIR, ...subdirs.map(String));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file.path));
  fs.renameSync(file.path, dest);
  file.path = dest;
  file.stored = true;
  return dest;
}

// Deletes files and prunes their folder when it ends up empty.
export function removeFiles(paths) {
  const root = path.resolve(UPLOAD_DIR);
  for (const p of paths) {
    if (!p) continue;
    fs.rmSync(p, { force: true });
    const dir = path.resolve(path.dirname(p));
    if (dir !== root && dir.startsWith(root + path.sep) && dir !== path.resolve(TMP_DIR)) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch {
        /* not empty / already gone */
      }
    }
  }
}
