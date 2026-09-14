# Google Cloud production path

This package deploys the **currently allowed public-information mode** to
Cloud Run in Bangkok (`asia-southeast3`). It is deliberately unable to accept
accounts, images, or screening requests. That is the only safe public release
while the 50-class model release remains blocked and the application still
uses SQLite and local filesystem paths for private data.

Do not bypass `SMART_SKIN_PUBLIC_INFORMATION_MODE=1`. A future private-image
deployment first needs a reviewed migration to Cloud SQL PostgreSQL and private
Cloud Storage, signed URLs or server-side object access, retention deletion,
restore drills, a data-processing review, and the model-release gate.

## What this deploys

- Cloud Run service: `smart-skin-public`
- immutable image in Artifact Registry: `smart-skin`
- a Flask secret read at runtime from Secret Manager
- public HTTPS from the initial `run.app` URL
- GitHub Actions access through short-lived Workload Identity Federation; no
  downloadable Google service-account key is required

The production custom domain `hucksmartskinai.com` is a separate final step.
Use a **Global External Application Load Balancer** with a Google-managed
certificate and Cloud Armor. Do not use Cloud Run's preview domain-mapping
feature as the production path.

## One-time Google Cloud setup

Perform these commands in an authenticated Google Cloud terminal. Replace only
the uppercase placeholders; do not put secrets in shell history, GitHub
variables, source code, or this repository.

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="asia-southeast3"
export REPOSITORY="smart-skin"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker --location="$REGION" \
  --description="Smart Skin AI immutable application images"

openssl rand -base64 48 | tr -d '\n' | \
  gcloud secrets create smart-skin-flask-secret --data-file=-
```

Record the Secret Manager version and restrict access to the Cloud Run runtime
service account only. Secret values are never added as GitHub repository
variables or Actions logs.

## GitHub Actions identity

Create a dedicated deploy service account, grant only the roles needed to
build/deploy this one service and read `smart-skin-flask-secret`, then configure
Workload Identity Federation with a strict attribute condition for this exact
repository and `main` branch. Add these GitHub **Secrets**:

```text
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

Add these GitHub **Variables** (not secrets):

```text
GCP_PROJECT_ID
GCP_REGION=asia-southeast3
SMART_SKIN_DATA_CONTROLLER_NAME
SMART_SKIN_PRIVACY_CONTACT
```

Do not grant Owner, Editor, Storage Admin, or broad Secret Manager roles to the
GitHub deploy identity. Create a separate runtime service account and limit it
to `roles/secretmanager.secretAccessor` on the one Flask-secret resource.

## First deployment and verification

After the variables and identity are configured, run the GitHub Actions
workflow **Deploy public information to Cloud Run** manually. It builds a
commit-addressed image and deploys only the public-information configuration.

Verify from an independent network:

```bash
curl --fail --silent --show-error https://SERVICE-URL/healthz
```

The initial runtime template permits the exact custom domains plus the
Cloud Run `.run.app` suffix solely so this first HTTPS verification can work.
After the load balancer domain is live, update `SMART_SKIN_ALLOWED_HOSTS` to
only `hucksmartskinai.com,www.hucksmartskinai.com` and redeploy.

Confirm that registration, sign-in, image upload, scans, admin routes, and
private image URLs are unavailable. Confirm that no runtime logs include a
secret, personal data, or precise location.

## Domain, HTTPS, WAF, and DNS

Before creating the public DNS records:

1. Reserve a global static IP and place a Global External Application Load
   Balancer in front of Cloud Run.
2. Attach a Google-managed certificate for `hucksmartskinai.com` and
   `www.hucksmartskinai.com`.
3. Attach a Cloud Armor policy with rate limits and the reviewed WAF rules.
4. Point the domain's DNS A/AAAA records to that load balancer's IP.
5. Enforce HTTPS redirect, test certificate renewal, then rerun `/healthz` and
   the public-information route checks.

DNS propagation and certificate provisioning can take time. Do not point the
domain at the service until the certificate is active and the HTTPS redirect is
verified.

## Required work before any private-image release

Cloud Run has an ephemeral filesystem and this application currently uses
SQLite plus local files for accounts and uploads. Therefore do **not** enable
private/account/image mode with this deployment. First complete all of these:

1. migrate SQLite data access to Cloud SQL PostgreSQL with encrypted backups;
2. move image objects and avatars to a private Cloud Storage bucket with
   lifecycle deletion and audited server-side access;
3. deploy a retention worker and test restore/deletion; and
4. satisfy the existing model-evaluation release gate before any image analysis
   is reachable.
