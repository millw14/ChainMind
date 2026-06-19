// Upload a file to Cloudflare R2 (S3-compatible) via SigV4 — no SDK dependency.
// Reads creds from env (.env.local):
//   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET=chainmind-backups
// Usage: node scripts/upload-backup-r2.mjs <local-file> [remote-key]
import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { loadEnv } from "../lib/load-env.js";
loadEnv();

const endpoint = process.env.R2_ENDPOINT?.replace(/\/$/, "");
const accessKey = process.env.R2_ACCESS_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
if (!endpoint || !accessKey || !secretKey || !bucket) {
  console.error("Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in .env.local");
  process.exit(1);
}
const localPath = process.argv[2];
if (!localPath) {
  console.error("Usage: node scripts/upload-backup-r2.mjs <local-file> [remote-key]");
  process.exit(1);
}
const key = process.argv[3] || `backups/${basename(localPath)}`;

const region = "auto";
const service = "s3";
const host = new URL(endpoint).host;
const body = readFileSync(localPath);
const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
const dateStamp = amzDate.slice(0, 8);
const payloadHash = "UNSIGNED-PAYLOAD";

const canonicalUri = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

const algo = "AWS4-HMAC-SHA256";
const scope = `${dateStamp}/${region}/${service}/aws4_request`;
const sha256hex = (d) => crypto.createHash("sha256").update(d).digest("hex");
const stringToSign = [algo, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
let signingKey = hmac("AWS4" + secretKey, dateStamp);
signingKey = hmac(signingKey, region);
signingKey = hmac(signingKey, service);
signingKey = hmac(signingKey, "aws4_request");
const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
const authorization = `${algo} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

const sizeMB = (statSync(localPath).size / 1024 / 1024).toFixed(1);
console.log(`uploading ${localPath} (${sizeMB} MB) → ${bucket}/${key} …`);
const res = await fetch(`${endpoint}${canonicalUri}`, {
  method: "PUT",
  headers: {
    Authorization: authorization,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "content-length": String(body.length),
  },
  body,
});
if (res.ok) {
  console.log(`OK (${res.status}) — uploaded to ${bucket}/${key}`);
} else {
  console.error(`FAILED ${res.status}:`, (await res.text()).slice(0, 400));
  process.exit(1);
}
