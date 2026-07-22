import express from "express";
import cors from "cors";
import archiver from "archiver";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const PORT = process.env.PORT || 8080;
const CLIENT_ID =
  process.env.CLIENT_ID ||
  "784973075726-pt9t0dcgembmg4icd6a2fva05bu4o0n8.apps.googleusercontent.com";
const DRIVE_ID = process.env.DRIVE_ID || "0AIubYFgsJvn_Uk9PVA";
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://datastore.physicalagentharness.com,http://localhost:8765,http://127.0.0.1:8765"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PERMS_TTL_MS = 60_000;

const app = express();
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, ALLOWED_ORIGINS.includes(origin));
    },
  })
);
app.disable("x-powered-by");

const oauthClient = new OAuth2Client(CLIENT_ID);
const authClient = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth: authClient });

const permsCache = new Map();

async function getAllowedEmails() {
  const now = Date.now();
  const cached = permsCache.get(DRIVE_ID);
  if (cached && now - cached.at < PERMS_TTL_MS) return cached.emails;

  const emails = new Set();
  let pageToken;
  do {
    const res = await drive.permissions.list({
      fileId: DRIVE_ID,
      supportsAllDrives: true,
      useDomainAdminAccess: false,
      pageSize: 100,
      fields: "permissions(emailAddress,role,type,deleted),nextPageToken",
      pageToken,
    });
    for (const p of res.data.permissions || []) {
      if (p.deleted) continue;
      if (p.emailAddress) emails.add(p.emailAddress.toLowerCase());
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  permsCache.set(DRIVE_ID, { at: now, emails });
  console.log("perms refresh:", DRIVE_ID, "count:", emails.size, "emails:", Array.from(emails));
  return emails;
}

async function verifyIdToken(header) {
  if (!header || !header.startsWith("Bearer ")) return null;
  const idToken = header.slice(7).trim();
  if (!idToken) return null;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) return null;
    return { email: payload.email.toLowerCase(), name: payload.name };
  } catch {
    return null;
  }
}

async function requireAuthorized(req, res) {
  const user = await verifyIdToken(req.header("authorization"));
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  const allowed = await getAllowedEmails();
  const ok = allowed.has(user.email);
  console.log("auth check:", user.email, "allowed:", ok, "size:", allowed.size);
  if (!ok) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return user;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, driveId: DRIVE_ID });
});

app.get("/api/list", async (req, res) => {
  const user = await requireAuthorized(req, res);
  if (!user) return;

  const folderId = String(req.query.folderId || DRIVE_ID);
  const fields =
    "files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,hasThumbnail,thumbnailLink,parents),nextPageToken";

  try {
    const all = [];
    let pageToken;
    do {
      const r = await drive.files.list({
        driveId: DRIVE_ID,
        corpora: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        q: `'${folderId}' in parents and trashed=false`,
        pageSize: 200,
        fields,
        pageToken,
      });
      for (const f of r.data.files || []) {
        all.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          size: f.size,
          webViewLink: f.webViewLink,
          iconLink: f.iconLink,
          hasThumbnail: f.hasThumbnail,
          thumbnailLink: f.thumbnailLink,
          isFolder: f.mimeType === "application/vnd.google-apps.folder",
        });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);

    res.json({ files: all });
  } catch (err) {
    console.error("drive.files.list failed", err?.errors || err?.message || err);
    const code = err?.code === 404 ? 404 : 502;
    res
      .status(code)
      .json({ error: code === 404 ? "not_found" : "drive_error" });
  }
});

// Sanitize a filename for zip entries — strips path separators and control chars.
function sanitizeName(name) {
  return String(name || "untitled")
    .replace(/[\\/\x00-\x1f]/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 200);
}

// List all non-trashed children of `parentId` in the shared drive.
async function listChildren(parentId) {
  const all = [];
  let pageToken;
  do {
    const r = await drive.files.list({
      driveId: DRIVE_ID,
      corpora: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parentId}' in parents and trashed=false`,
      pageSize: 200,
      fields: "files(id,name,mimeType,size),nextPageToken",
      pageToken,
    });
    for (const f of r.data.files || []) all.push(f);
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return all;
}

// Walk the drive from `rootId` and return a flat list of file entries with
// their zip-relative paths (folders become path segments).
async function walkDrive(rootId) {
  const files = [];
  const queue = [{ id: rootId, path: "" }];
  while (queue.length) {
    const { id, path } = queue.shift();
    const children = await listChildren(id);
    for (const c of children) {
      const name = sanitizeName(c.name);
      if (c.mimeType === "application/vnd.google-apps.folder") {
        queue.push({ id: c.id, path: path ? `${path}/${name}` : name });
      } else {
        files.push({
          id: c.id,
          name,
          mimeType: c.mimeType,
          path: path ? `${path}/${name}` : name,
        });
      }
    }
  }
  return files;
}

// Pick the export mime + filename extension for Google-native docs. Everything
// gets exported as PDF per the "Everything as PDF" onboarding choice.
function googleExportSpec(mimeType) {
  if (!mimeType?.startsWith("application/vnd.google-apps.")) return null;
  if (mimeType === "application/vnd.google-apps.folder") return null;
  // Google Sites, Forms, etc. can't export to PDF via files.export.
  if (
    mimeType === "application/vnd.google-apps.document" ||
    mimeType === "application/vnd.google-apps.spreadsheet" ||
    mimeType === "application/vnd.google-apps.presentation" ||
    mimeType === "application/vnd.google-apps.drawing"
  ) {
    return { exportMimeType: "application/pdf", ext: ".pdf" };
  }
  return { skip: true };
}

app.get("/api/zip", async (req, res) => {
  const user = await requireAuthorized(req, res);
  if (!user) return;

  const dateStamp = new Date().toISOString().slice(0, 10);
  const zipName = `eli-hive-dataroom-${dateStamp}.zip`;

  let files;
  try {
    files = await walkDrive(DRIVE_ID);
  } catch (err) {
    console.error("zip walk failed", err?.errors || err?.message || err);
    res.status(502).json({ error: "drive_error" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
  res.setHeader("Cache-Control", "no-store");

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("warning", (err) => console.warn("archiver warning", err));
  archive.on("error", (err) => {
    console.error("archiver error", err);
    try { res.destroy(err); } catch { /* ignore */ }
  });
  archive.pipe(res);

  for (const f of files) {
    try {
      const nativeSpec = googleExportSpec(f.mimeType);
      if (nativeSpec && nativeSpec.skip) continue;
      if (nativeSpec) {
        const r = await drive.files.export(
          { fileId: f.id, mimeType: nativeSpec.exportMimeType },
          { responseType: "stream", supportsAllDrives: true }
        );
        const nameWithExt = f.path.match(/\.[a-z0-9]{2,5}$/i) ? f.path : `${f.path}${nativeSpec.ext}`;
        archive.append(r.data, { name: nameWithExt });
        await new Promise((resolve, reject) => {
          r.data.on("end", resolve);
          r.data.on("error", reject);
        });
      } else {
        const r = await drive.files.get(
          { fileId: f.id, alt: "media", supportsAllDrives: true },
          { responseType: "stream" }
        );
        archive.append(r.data, { name: f.path });
        await new Promise((resolve, reject) => {
          r.data.on("end", resolve);
          r.data.on("error", reject);
        });
      }
    } catch (err) {
      console.error("zip skip file", f.path, err?.errors || err?.message || err);
      archive.append(`Failed to fetch: ${f.name}\n`, { name: `${f.path}.ERROR.txt` });
    }
  }

  archive.finalize().catch((err) => {
    console.error("finalize failed", err);
  });
});

app.listen(PORT, () => {
  console.log(`dataroom-api listening on :${PORT}`);
});
