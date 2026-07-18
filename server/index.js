import express from "express";
import cors from "cors";
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
  if (!allowed.has(user.email)) {
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

app.listen(PORT, () => {
  console.log(`dataroom-api listening on :${PORT}`);
});
