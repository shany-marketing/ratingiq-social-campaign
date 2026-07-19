import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";
import { createRequire } from "module";

config();

const require = createRequire(import.meta.url);
const FFMPEG  = require("@ffmpeg-installer/ffmpeg").path;

function transcodeForLinkedIn(inputPath) {
  const outputPath = inputPath.replace(/\.mp4$/i, "_transcoded.mp4");
  execSync(
    `"${FFMPEG}" -y -i "${inputPath}" ` +
    `-vcodec libx264 -acodec aac -r 30 ` +
    `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,colorspace=bt709:iall=bt470bg:all=bt709:fast=1,format=yuv420p" ` +
    `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv ` +
    `-b:v 4M -maxrate 5M -bufsize 10M -preset fast -g 60 ` +
    `-movflags +faststart "${outputPath}"`,
    { stdio: "pipe" }
  );
  return outputPath;
}

const DIR           = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_FILE = join(DIR, "schedule.json");
const CAMPAIGN_FILE = join(DIR, "../index.html");
const VISUALS_DIR   = join(DIR, "visuals") + "/";

const today = new Date().toISOString().split("T")[0];


async function registerAndUpload(token, author, filePath, recipe, contentType) {
  const reg = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner: author,
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    }),
  });
  const regData = await reg.json();
  if (!reg.ok) throw new Error(`Media register failed: ${JSON.stringify(regData)}`);

  const uploadUrl = regData.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
  const asset = regData.value.asset;

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: readFileSync(filePath),
  });
  if (!put.ok) throw new Error(`Media PUT failed: ${put.status}`);

  return asset;
}

const uploadImage = (t, a, p) => registerAndUpload(t, a, p, "urn:li:digitalmediaRecipe:feedshare-image", "image/jpeg");
const uploadVideo = (t, a, p) => registerAndUpload(t, a, p, "urn:li:digitalmediaRecipe:feedshare-video",  "video/mp4");

// Hardcoded URNs for our own accounts — always resolved even without API lookup.
const MENTION_MAP = {
  "ratingiq":  () => ({ urn: process.env.LINKEDIN_ORG_URN, type: "company" }),
  "rating-iq": () => ({ urn: process.env.LINKEDIN_ORG_URN, type: "company" }),
};

const POST_FOOTER = "\n\n@RatingIQ\nwww.rating-iq.com";

const MENTION_CACHE_FILE = join(DIR, "mention_cache.json");

function loadMentionCache() {
  if (existsSync(MENTION_CACHE_FILE)) {
    try { return JSON.parse(readFileSync(MENTION_CACHE_FILE, "utf8")); } catch {}
  }
  return {};
}

function saveMentionCache(cache) {
  writeFileSync(MENTION_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Tries to resolve an @handle to a LinkedIn org URN via vanity-name lookup.
async function tryResolveOrg(handle, token) {
  const vanity = handle.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
  try {
    const r = await fetch(
      `https://api.linkedin.com/v2/organizations?q=vanityName&vanityName=${encodeURIComponent(vanity)}`,
      { headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" } }
    );
    const data = await r.json();
    if (r.ok && data.elements?.[0]?.id) {
      return { urn: `urn:li:organization:${data.elements[0].id}`, type: "company" };
    }
  } catch {}
  return null;
}

// Scans text for unknown @mentions and attempts LinkedIn org lookup; updates cache in place.
async function resolveUnknownMentions(text, token) {
  const cache = loadMentionCache();
  const re = /@([\w-]+)/g;
  let m;
  let changed = false;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    if (MENTION_MAP[key] || cache[key]) continue;
    console.log(`  ↳ Resolving @${m[1]} via LinkedIn API...`);
    const entity = await tryResolveOrg(m[1], token);
    if (entity) {
      cache[key] = entity;
      changed = true;
      console.log(`  ✓ @${m[1]} → ${entity.urn}`);
    } else {
      cache[key] = null; // mark as unresolvable so we don't retry every post
      changed = true;
      console.log(`  ✗ @${m[1]} unresolved — will post as plain text`);
    }
  }
  if (changed) saveMentionCache(cache);
  return cache;
}

// Appends footer and builds LinkedIn attribute objects for all resolved @mentions.
function buildCopy(raw, cache = {}) {
  const text = raw.trimEnd() + POST_FOOTER;
  const attributes = [];
  const re = /@([\w-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const entity = MENTION_MAP[key] ? MENTION_MAP[key]() : cache[key];
    if (!entity?.urn) continue;
    attributes.push({
      start: m.index,
      length: m[0].length,
      value: entity.type === "company"
        ? { "com.linkedin.common.CompanyAttributedEntity": { company: entity.urn } }
        : { "com.linkedin.common.MemberAttributedEntity":  { member:  entity.urn } },
    });
  }
  return { text, attributes };
}

async function postToLinkedIn(profile, text, reshareUrn = null, imagePath = null, videoPath = null) {
  const tokenKey = profile === "omri" ? "LINKEDIN_OMRI_TOKEN"
    : profile === "shany" ? "LINKEDIN_SHANY_TOKEN"
    : "LINKEDIN_ORG_TOKEN";

  const urnKey = profile === "omri" ? "LINKEDIN_OMRI_URN"
    : profile === "shany" ? "LINKEDIN_SHANY_URN"
    : "LINKEDIN_ORG_URN";

  const token = process.env[tokenKey];
  const author = process.env[urnKey];

  if (!token || !author) {
    throw new Error(`Missing token or URN for profile: ${profile}`);
  }

  // Auto-resolve any @mentions not yet in cache before building the copy.
  const cache = await resolveUnknownMentions(text + POST_FOOTER, token);

  if (reshareUrn) {
    // Reshare via /v2/shares — image not supported on reshares
    const { text: resolvedText, attributes } = buildCopy(text, cache);
    const textObj = attributes.length
      ? { text: resolvedText, attributes }
      : { text: resolvedText };
    const body = {
      owner: author,
      resharedShare: reshareUrn,
      text: textObj,
    };
    const res = await fetch("https://api.linkedin.com/v2/shares", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data.id;
  }

  // Standalone post via /v2/ugcPosts
  let mediaAsset = null;
  let mediaCategory = "NONE";
  if (imagePath && existsSync(imagePath)) {
    mediaAsset = await uploadImage(token, author, imagePath);
    mediaCategory = "IMAGE";
  } else if (videoPath && existsSync(videoPath)) {
    mediaAsset = await uploadVideo(token, author, videoPath);
    mediaCategory = "VIDEO";
  }

  const { text: resolvedText, attributes } = buildCopy(text, cache);
  const commentary = attributes.length
    ? { text: resolvedText, attributes }
    : { text: resolvedText };

  const shareContent = mediaAsset
    ? {
        shareCommentary: commentary,
        shareMediaCategory: mediaCategory,
        media: [{ status: "READY", media: mediaAsset }],
      }
    : {
        shareCommentary: commentary,
        shareMediaCategory: "NONE",
      };

  const body = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: { "com.linkedin.ugc.ShareContent": shareContent },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.id;
}

function runCompanyPost(schedule, omriPost) {
  // Find a company post on the same date that pairs with this Omri post
  const companion = schedule.find(p =>
    p.date === omriPost.date &&
    p.profile === "company" &&
    p.status === "scheduled" &&
    p.approved === true
  );
  if (!companion) return;

  const isReshare = companion.reshareOf === omriPost.id;
  const scriptName = isReshare ? "reshare_company.js" : "post_company.js";
  const imagePath = `${VISUALS_DIR}${omriPost.id}.jpg`;

  let scriptArgs = ["--id", companion.id, "--copy", companion.copy];
  if (isReshare) {
    scriptArgs.push("--parent-urn", omriPost.linkedInId);
  } else if (existsSync(imagePath)) {
    scriptArgs.push("--image", imagePath);
  }

  console.log(`\nRunning company ${isReshare ? "reshare" : "post"}: ${companion.id}...`);
  const result = spawnSync("node", [join(DIR, scriptName), ...scriptArgs], { stdio: "inherit" });

  if (result.status === 0) {
    companion.status = "published";
    companion.publishedAt = new Date().toISOString();
    updateCampaignStatus(companion.id, "published");
    console.log(`✓ Company ${isReshare ? "reshare" : "post"} done: ${companion.id}`);
  } else {
    companion.status = "failed";
    companion.error = `Browser script exited with code ${result.status}`;
    console.error(`✗ Company post failed: ${companion.id}`);
  }
}

function updateCampaignStatus(postId, status) {
  try {
    let html = readFileSync(CAMPAIGN_FILE, "utf8");
    const regex = new RegExp(`(id:'${postId}'[^}]*status:)'[^']*'`);
    html = html.replace(regex, `$1'${status}'`);
    writeFileSync(CAMPAIGN_FILE, html);
  } catch (e) {
    console.log(`Note: Could not update campaign file status for ${postId}: ${e.message}`);
  }
}

async function withRetry(fn, label, maxAttempts = 4, baseDelayMs = 15000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      const delay = baseDelayMs * attempt;
      console.log(`  ↳ Attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function run() {
  const retryOnly = process.argv.includes("--retry-only");
  const schedule = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
  const now = Date.now();

  // Auto-approve posts whose visual is on disk — board sync is unreliable from GitHub Pages
  schedule.forEach(p => {
    if (!p.approved && p.status === "scheduled" && p.date === today) {
      const hasImage = existsSync(`${VISUALS_DIR}${p.id}.jpg`);
      const hasVideo = existsSync(`${VISUALS_DIR}${p.id}.mp4`);
      const isTextOnly = !p.visual || p.visual === '';
      if (hasImage || hasVideo || isTextOnly) {
        p.approved = true;
        console.log(`  ✓ Auto-approved ${p.id} (visual ready)`);
      }
    }
  });

  const due = schedule.filter(p =>
    p.date === today && p.approved === true && (
      (!retryOnly && p.status === "scheduled") ||
      (p.status === "failed" && p.retryAfter && p.retryAfter <= now)
    )
  );
  const notReady = schedule.filter(p => p.date === today && p.status === "scheduled" && !p.approved);

  if (notReady.length > 0) {
    console.log(`⚠ Skipped ${notReady.length} post(s) — visual not ready: ${notReady.map(p => p.id).join(", ")}`);
  }

  if (due.length === 0) {
    console.log(`[${today}] No posts scheduled for today.`);
    return;
  }

  console.log(`[${today}] Found ${due.length} post(s) to publish.`);

  for (const post of due) {
    try {
      if (post.profile === "group" || post.profile === "company") {
        // group = manual; company = handled by runCompanyPost after Omri publishes
        continue;
      }

      let reshareUrn = null;
      if (post.reshareOf) {
        const parent = schedule.find(p => p.id === post.reshareOf);
        if (parent?.profile === "company") {
          console.log(`⏭ Skipped ${post.id} — reshares of company posts are done manually`);
          continue;
        }
        if (!parent?.linkedInId) {
          console.log(`⏳ Skipped ${post.id} — waiting for parent post ${post.reshareOf} to be published`);
          continue;
        }
        reshareUrn = parent.linkedInId;
      }

      const imagePath = (!reshareUrn && post.type !== 'video') ? `${VISUALS_DIR}${post.id}.jpg` : null;
      const videoPath = (!reshareUrn && post.type === 'video') ? `${VISUALS_DIR}${post.id}.mp4` : null;
      const hasImage = imagePath && existsSync(imagePath);
      const hasVideo = videoPath && existsSync(videoPath);
      if (hasImage) console.log(`  ↳ Image found: ${post.id}.jpg`);
      if (hasVideo) console.log(`  ↳ Video found: ${post.id}.mp4`);

      let finalVideoPath = hasVideo ? videoPath : null;
      if (hasVideo) {
        console.log(`  ↳ Transcoding video for LinkedIn...`);
        finalVideoPath = transcodeForLinkedIn(videoPath);
        console.log(`  ↳ Transcoded: ${finalVideoPath}`);
      }

      console.log(`Posting ${post.id} as ${post.profile}${reshareUrn ? ' (reshare)' : ''}${hasImage ? ' + image' : ''}${hasVideo ? ' + video' : ''}...`);
      const linkedInId = await withRetry(() => postToLinkedIn(post.profile, post.copy, reshareUrn, hasImage ? imagePath : null, finalVideoPath), post.id);
      post.status = "published";
      post.linkedInId = linkedInId;
      post.publishedAt = new Date().toISOString();
      updateCampaignStatus(post.id, "published");
      console.log(`✓ Published: ${post.id} — LinkedIn ID: ${linkedInId}`);

      // After Omri posts: auto-approve and process all same-day reshare children
      if (post.profile === "omri") {
        const children = schedule.filter(p =>
          p.reshareOf === post.id && p.date === today && p.status === "scheduled"
        );
        children.forEach(c => { c.approved = true; });
        writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));

        // Company reshare (handled by browser script)
        runCompanyPost(schedule, post);

        // Shany reshare (post directly via API)
        const shanyChild = children.find(p => p.profile === "shany");
        if (shanyChild) {
          try {
            console.log(`\nPosting Shany reshare: ${shanyChild.id}...`);
            const shanyId = await withRetry(() => postToLinkedIn("shany", shanyChild.copy, post.linkedInId, null, null), shanyChild.id);
            shanyChild.status = "published";
            shanyChild.linkedInId = shanyId;
            shanyChild.publishedAt = new Date().toISOString();
            updateCampaignStatus(shanyChild.id, "published");
            console.log(`✓ Shany reshare published: ${shanyChild.id}`);
          } catch (e) {
            shanyChild.status = "failed";
            shanyChild.error = e.message;
            console.error(`✗ Shany reshare failed: ${shanyChild.id} — ${e.message}`);
          }
        }
      }
      if (finalVideoPath && finalVideoPath !== videoPath) {
        try { unlinkSync(finalVideoPath); } catch {}
      }
    } catch (e) {
      // Auto-reschedule to next day so it shows correctly in the UI and retries tomorrow
      const nextDay = new Date();
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDate = nextDay.toISOString().split('T')[0];
      post.date = nextDate;
      post.status = "scheduled";
      post.error = e.message;
      // Cascade next-day date to reshare children
      schedule.forEach(p => { if (p.reshareOf === post.id) p.date = nextDate; });
      console.error(`✗ Failed: ${post.id} — ${e.message} — rescheduled to ${nextDate}`);
    }
  }

  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  console.log("Done.");
}

run();
