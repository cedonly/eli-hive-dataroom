# dataroom-api

Small Cloud Run service that proxies read-only Google Drive listings for the
Eli Hive dataroom static site. Fronts the shared drive using a service
account, so the browser never needs a Drive OAuth scope — investors sign in
with Google using only `openid email profile` (non-sensitive), and this
service checks their email against the drive's sharing list before returning
any data.

## What it does

- `GET /api/health` — liveness.
- `GET /api/list?folderId=<id>` — verifies the caller's Google ID token,
  checks the caller's email against the shared drive's permissions, and
  returns the folder listing. Defaults `folderId` to the drive root.

Permission checks are cached in-process for 60 seconds, so adding or
removing an investor in Drive takes effect within a minute.

## First-time setup

Run these once, from any machine with the `gcloud` CLI signed in to the
project that owns the shared drive.

### 1. Create a service account for the runtime

```
gcloud iam service-accounts create dataroom-api \
  --display-name="Dataroom API"
```

Grab its email — it will look like
`dataroom-api@<project-id>.iam.gserviceaccount.com`. Nothing else needs to
be granted to it at the IAM level; the Drive access comes from sharing.

### 2. Share the drive with the service account

In the Google Drive UI, open the shared drive
(`https://drive.google.com/drive/folders/0AIubYFgsJvn_Uk9PVA`) → **Manage
members** → add the service account email as **Content manager**.

(Viewer works too if you only ever call `/api/list`, but Content manager
future-proofs you for anything write-related.)

### 3. Enable the required APIs

```
gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  drive.googleapis.com \
  artifactregistry.googleapis.com
```

### 4. Deploy

From the repo root:

```
gcloud run deploy dataroom-api \
  --source ./server \
  --region us-central1 \
  --allow-unauthenticated \
  --service-account dataroom-api@<project-id>.iam.gserviceaccount.com \
  --set-env-vars ALLOWED_ORIGINS=https://datastore.physicalagentharness.com
```

The `--allow-unauthenticated` flag exposes the HTTPS endpoint publicly — the
service enforces auth itself by verifying Google ID tokens.

gcloud will print an HTTPS URL like
`https://dataroom-api-xxxxxxx-uc.a.run.app`. Point the client at that (or
map a custom domain — next section).

### 5. (Optional) Custom domain

Cloud Run → **Domain Mappings** → **Add mapping** → service
`dataroom-api`, domain `api.datastore.physicalagentharness.com`. Add the
CNAME record it prints to your DNS. The managed TLS cert is free and
provisions in a few minutes.

## Local development

```
cd server
npm install
gcloud auth application-default login   # once
npm run dev
```

Then in another shell:

```
curl http://localhost:8080/api/health

# grab an ID token from the deployed site's devtools (network → any /api/list
# call → Authorization header) and reuse it here:
curl -H "Authorization: Bearer <id_token>" \
  "http://localhost:8080/api/list?folderId=0AIubYFgsJvn_Uk9PVA"
```

`gcloud auth application-default login` gives your local machine
Application Default Credentials as **you**, so listing works if your email
is on the drive. Once deployed, ADC resolves to the runtime service
account instead — no key file required, no secrets to manage.

## Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Cloud Run sets this automatically. |
| `CLIENT_ID` | current web OAuth client | Used to verify ID token audience. |
| `DRIVE_ID` | `0AIubYFgsJvn_Uk9PVA` | Shared drive root ID. |
| `ALLOWED_ORIGINS` | prod + localhost | Comma-separated CORS allowlist. |

## Consent screen cleanup

Once the client no longer requests `drive.metadata.readonly`:

1. GCP Console → APIs & Services → **OAuth consent screen** → **Edit**.
2. Remove `.../auth/drive.metadata.readonly` from the scopes list; leave
   only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
3. Publishing status → **In production**. Non-sensitive scopes go live
   without review — no CASA, no verification.

The test-user allowlist becomes irrelevant. From then on, adding an
investor is a single Drive-share operation.
