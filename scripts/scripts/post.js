// post.js
// Runs daily. Picks one unposted carousel and publishes it to Instagram.

import fs from "fs/promises";

const MANIFEST = "manifest.json";
const API = "https://graph.instagram.com/v21.0";

const TOKEN = process.env.IG_ACCESS_TOKEN;
const USER_ID = process.env.IG_USER_ID;
const BASE_URL = (process.env.PAGES_BASE_URL || "").replace(/\/+$/, "");

// Don't repeat a belief topic within this many posts.
const TOPIC_COOLDOWN = 5;

// Instagram fetches each image asynchronously. Publishing before that
// finishes is the most common cause of failure.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;

// Keywords registered in Meta Business Suite's comment-to-DM automation.
// The artifact picks one per carousel and writes it into the caption and
// slide 7. The comment below has to match whichever one this carousel used,
// or it points people at a word that will not trigger the automation.
const REGISTERED_KEYWORDS = [
  "SAFE", "SEEN", "WORTHY", "ENOUGH", "READY",
  "LOVED", "TRUST", "ALLOWED", "POWERFUL", "WHOLE",
];

const LEAD_MAGNET_URL = "rewritethebelief.com";

// Pulls the keyword out of a caption opening like:
//   Comment "WORTHY" and I'll send you the FREE Hidden Belief Map.
// Returns null if nothing recognisable is found, rather than guessing.
function extractKeyword(caption) {
  const quoted = caption.match(/comment\s*["“']([A-Z]{3,12})["”']/i);
  if (quoted) {
    const word = quoted[1].toUpperCase();
    if (REGISTERED_KEYWORDS.includes(word)) return word;
  }

  const bare = caption.match(/comment\s+([A-Z]{3,12})\b/);
  if (bare && REGISTERED_KEYWORDS.includes(bare[1])) return bare[1];

  for (const word of REGISTERED_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`).test(caption)) return word;
  }
  return null;
}

function buildComment(caption) {
  const keyword = extractKeyword(caption);

  if (!keyword) {
    // Never invent a keyword. A comment with just the link still works for
    // anyone the automation would have missed anyway.
    console.log(
      "::warning::No registered keyword found in this caption. " +
        "Posting a comment with the link only."
    );
    return `Your FREE Hidden Belief Map is here 👇 ${LEAD_MAGNET_URL}`;
  }

  console.log(`  keyword for this carousel: ${keyword}`);
  return (
    `Comment ${keyword} and I'll send you the FREE Hidden Belief Map 👇 ` +
    `Or take it now: ${LEAD_MAGNET_URL}`
  );
}

function requireEnv() {
  const missing = [];
  if (!TOKEN) missing.push("IG_ACCESS_TOKEN");
  if (!USER_ID) missing.push("IG_USER_ID");
  if (!BASE_URL) missing.push("PAGES_BASE_URL");
  if (missing.length) {
    throw new Error(`Missing repository secret(s): ${missing.join(", ")}`);
  }
}

async function ig(pathname, params, method = "POST") {
  const url = new URL(`${API}${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });

  const res =
    method === "GET"
      ? await fetch(`${url}?${body}`)
      : await fetch(url, { method, body });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Instagram returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(
      `Instagram API ${res.status}: ${e.message || text.slice(0, 300)}` +
        (e.error_user_msg ? ` — ${e.error_user_msg}` : "")
    );
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForContainer(id) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { status_code, status } = await ig(
      `/${id}`,
      { fields: "status_code,status" },
      "GET"
    );

    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`Container ${id} ended as ${status_code}: ${status || "no detail"}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Container ${id} was still processing after ${POLL_TIMEOUT_MS / 1000}s`);
}

function choose(manifest) {
  const pending = manifest.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;

  const recentTopics = manifest
    .filter((e) => e.status === "posted" && e.posted_at)
    .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
    .slice(0, TOPIC_COOLDOWN)
    .map((e) => e.topic);

  const preferred = pending.filter((e) => !recentTopics.includes(e.topic));
  const pool = preferred.length > 0 ? preferred : pending;

  return pool[Math.floor(Math.random() * pool.length)];
}

async function main() {
  requireEnv();

  const manifest = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
  const entry = choose(manifest);

  if (!entry) {
    console.log("::warning::Carousel library is empty. Nothing was posted.");
    await fs.writeFile("EMPTY_LIBRARY", "1");
    return;
  }

  console.log(`Publishing ${entry.id} (topic: ${entry.topic}, ${entry.slides.length} slides)`);

  try {
    // 1. One container per slide, in order.
    const children = [];
    for (let i = 0; i < entry.slides.length; i++) {
      const imageUrl = `${BASE_URL}/${entry.slides[i]}`;
      console.log(`  slide ${i + 1}: ${imageUrl}`);

      const { id } = await ig("/" + USER_ID + "/media", {
        image_url: imageUrl,
        is_carousel_item: "true",
      });
      children.push(id);
    }

    // 2. Wait for every slide to finish processing.
    console.log("  waiting for Instagram to process slides...");
    for (const id of children) await waitForContainer(id);

    // 3. Parent carousel container.
    const parent = await ig("/" + USER_ID + "/media", {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: entry.caption,
    });
    await waitForContainer(parent.id);

    // 4. Publish.
    const published = await ig("/" + USER_ID + "/media_publish", {
      creation_id: parent.id,
    });
    console.log(`  published as media ${published.id}`);

    // 5. Auto-comment. A failure here must not undo a successful post.
    try {
      await ig(`/${published.id}/comments`, { message: buildComment(entry.caption) });
      console.log("  CTA comment added");
    } catch (err) {
      console.log(`::warning::Post succeeded but the CTA comment failed: ${err.message}`);
    }

    entry.status = "posted";
    entry.posted_at = new Date().toISOString();
    entry.media_id = published.id;
    entry.error = null;
  } catch (err) {
    entry.status = "failed";
    entry.error = err.message;
    await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    await fs.writeFile("POST_FAILED", err.message);
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  const remaining = manifest.filter((e) => e.status === "pending").length;
  const log = `- ${entry.posted_at} — ${entry.id} (${entry.topic}) — ${remaining} left\n`;
  await fs.appendFile("post-log.md", log);

  console.log(`Done. ${remaining} carousel(s) remaining.`);

  if (remaining <= 5) {
    console.log(`::warning::Only ${remaining} carousels left. Time to top up the library.`);
    await fs.writeFile("LOW_LIBRARY", String(remaining));
  }
}

main().catch(async (err) => {
  console.error("::error::" + err.message);
  await fs.writeFile("POST_FAILED", err.message).catch(() => {});
  process.exit(1);
});
