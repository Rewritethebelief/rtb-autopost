// refresh-token.js
// Runs monthly. Instagram long-lived tokens expire after 60 days.
// This fetches a fresh one and writes it back into the repository secret.
// If this stops working, the whole system dies silently 60 days later.

import sodium from "libsodium-wrappers";

const TOKEN = process.env.IG_ACCESS_TOKEN;
const PAT = process.env.SECRETS_PAT;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/name"

const SECRET_NAME = "IG_ACCESS_TOKEN";

function requireEnv() {
  const missing = [];
  if (!TOKEN) missing.push("IG_ACCESS_TOKEN");
  if (!PAT) missing.push("SECRETS_PAT");
  if (!REPO) missing.push("GITHUB_REPOSITORY");
  if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);
}

async function gh(pathname, options = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `GitHub returned ${res.status}. SECRETS_PAT is probably expired, or lacks ` +
          `"Secrets: read and write" on ${REPO}. Body: ${body.slice(0, 200)}`
      );
    }
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.status === 204 ? null : res.json();
}

async function refreshInstagramToken() {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", TOKEN);

  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok || json.error) {
    throw new Error(
      `Token refresh failed: ${json.error?.message || JSON.stringify(json).slice(0, 300)}. ` +
        `If the token has already expired, generate a new one in the Meta app dashboard ` +
        `and update the IG_ACCESS_TOKEN secret by hand.`
    );
  }

  if (!json.access_token) throw new Error("Instagram returned no access_token");
  return json;
}

async function writeSecret(value) {
  const key = await gh(`/repos/${REPO}/actions/secrets/public-key`);

  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)
  );

  await gh(`/repos/${REPO}/actions/secrets/${SECRET_NAME}`, {
    method: "PUT",
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
      key_id: key.key_id,
    }),
  });
}

async function main() {
  requireEnv();

  console.log("Requesting a fresh Instagram token...");
  const { access_token, expires_in } = await refreshInstagramToken();

  const days = Math.round((expires_in || 0) / 86400);
  const expiry = new Date(Date.now() + (expires_in || 0) * 1000)
    .toISOString()
    .slice(0, 10);

  console.log(`New token valid for ~${days} days (until ${expiry}).`);

  await writeSecret(access_token);
  console.log(`Secret ${SECRET_NAME} updated. Next refresh runs on the 1st.`);
}

main().catch(async (err) => {
  console.error("::error::" + err.message);
  const fs = await import("fs/promises");
  await fs.writeFile("REFRESH_FAILED", err.message).catch(() => {});
  process.exit(1);
});
