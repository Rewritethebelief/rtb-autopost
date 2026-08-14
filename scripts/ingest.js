// ingest.js
// Runs on every push to carousels/
// Converts slide images to JPEG, extracts the caption, updates manifest.json.
// Already-ingested carousels are left alone.

import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

const CAROUSELS_DIR = "carousels";
const PUBLISHED_DIR = "published";
const MANIFEST = "manifest.json";

const IMAGE_EXT = [".png", ".jpg", ".jpeg"];
const MIN_SLIDES = 3;
const MAX_SLIDES = 10;

// Everything from this line onward in the caption file is Brent's own
// posting instructions and must never reach Instagram.
const CAPTION_END_MARKER = /^SET THIS ONCE/i;

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST, "utf8"));
  } catch {
    return [];
  }
}

// "abandonment-01" -> "abandonment"
function topicFromId(id) {
  return id.replace(/[-_]\d+$/, "");
}

// Sorts by the number in "slide-7-trigger.png" so slide-10 lands after
// slide-9 instead of after slide-1.
function slideNumber(filename) {
  const m = filename.match(/slide[-_]?(\d+)/i);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function extractCaption(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let started = false;

  for (const line of lines) {
    if (!started) {
      // Skip the "CAPTION" header and its ——— underline.
      if (/^CAPTION\s*$/i.test(line.trim())) {
        started = true;
      }
      continue;
    }
    if (CAPTION_END_MARKER.test(line.trim())) break;
    if (/^[—\-–_=]{3,}$/.test(line.trim())) continue;
    out.push(line);
  }

  // If the file had no CAPTION header, fall back to everything before the
  // instructions block rather than failing outright.
  if (!started) {
    for (const line of lines) {
      if (CAPTION_END_MARKER.test(line.trim())) break;
      out.push(line);
    }
  }

  return out.join("\n").trim();
}

async function findCaptionFile(dir) {
  const entries = await fs.readdir(dir);
  const txt = entries.find((f) => f.toLowerCase().endsWith(".txt"));
  return txt ? path.join(dir, txt) : null;
}

// Samples an opaque pixel just inside the rounded corner so transparent
// corners get filled with the slide's real background instead of white.
async function backgroundColour(src) {
  const { width, height } = await sharp(src).metadata();
  const inset = Math.round(Math.min(width, height) * 0.08);

  const px = await sharp(src)
    .extract({ left: inset, top: inset, width: 2, height: 2 })
    .raw()
    .toBuffer();

  if (px[3] !== undefined && px[3] < 250) {
    return { r: 0, g: 0, b: 0 };
  }
  return { r: px[0], g: px[1], b: px[2] };
}

async function ingestOne(id) {
  const srcDir = path.join(CAROUSELS_DIR, id);
  const outDir = path.join(PUBLISHED_DIR, id);

  const entries = await fs.readdir(srcDir);

  const images = entries
    .filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (images.length < MIN_SLIDES || images.length > MAX_SLIDES) {
    throw new Error(
      `${images.length} images found; Instagram carousels need ${MIN_SLIDES}-${MAX_SLIDES}`
    );
  }

  const captionFile = await findCaptionFile(srcDir);
  if (!captionFile) throw new Error("no .txt caption file found");

  const caption = extractCaption(await fs.readFile(captionFile, "utf8"));
  if (!caption) throw new Error("caption file produced empty caption");

  await fs.mkdir(outDir, { recursive: true });

  const slides = [];
  let firstRatio = null;

  for (let i = 0; i < images.length; i++) {
    const src = path.join(srcDir, images[i]);
    const outName = `slide-${i + 1}.jpg`;
    const dest = path.join(outDir, outName);

    const meta = await sharp(src).metadata();
    const ratio = meta.width / meta.height;

    if (firstRatio === null) {
      firstRatio = ratio;
    } else if (Math.abs(ratio - firstRatio) > 0.02) {
      // Instagram crops every slide to match the first one.
      throw new Error(
        `${images[i]} has a different aspect ratio to slide 1; Instagram would crop it`
      );
    }

    // Instagram rejects PNG, and JPEG has no transparency. The slides have
    // rounded corners with transparent pixels behind them, so those corners
    // are filled with the slide's own background colour — sampled from the
    // image itself rather than hardcoded, so it survives a design change.
    const bg = await backgroundColour(src);

    await sharp(src)
      .flatten({ background: bg })
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(dest);

    slides.push(`${PUBLISHED_DIR}/${id}/${outName}`);
  }

  return {
    id,
    topic: topicFromId(id),
    slides,
    caption,
    status: "pending",
    posted_at: null,
    error: null,
  };
}

async function main() {
  const manifest = await readManifest();
  const known = new Set(manifest.map((e) => e.id));

  let dirs = [];
  try {
    dirs = (await fs.readdir(CAROUSELS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    console.log("No carousels/ directory yet. Nothing to do.");
    return;
  }

  const fresh = dirs.filter((d) => !known.has(d));

  if (fresh.length === 0) {
    console.log("No new carousels. Manifest unchanged.");
    return;
  }

  console.log(`Found ${fresh.length} new carousel(s): ${fresh.join(", ")}`);

  let added = 0;
  const skipped = [];

  for (const id of fresh) {
    try {
      const entry = await ingestOne(id);
      manifest.push(entry);
      added++;
      console.log(`  OK   ${id} — ${entry.slides.length} slides`);
    } catch (err) {
      skipped.push(`${id}: ${err.message}`);
      console.error(`  SKIP ${id} — ${err.message}`);
    }
  }

  if (added > 0) {
    await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  }

  const pending = manifest.filter((e) => e.status === "pending").length;
  console.log(`\nAdded ${added}. Skipped ${skipped.length}.`);
  console.log(`Library now holds ${pending} unposted carousel(s).`);

  if (skipped.length > 0) {
    console.log("\nSkipped carousels need fixing and re-pushing:");
    skipped.forEach((s) => console.log(`  - ${s}`));
  }
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
