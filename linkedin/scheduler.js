import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "dotenv";

config();

const SCHEDULE_FILE = new URL("./schedule.json", import.meta.url).pathname;
const CAMPAIGN_FILE = new URL("../index.html", import.meta.url).pathname;
const VISUALS_DIR   = new URL("./visuals/", import.meta.url).pathname;

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

  if (reshareUrn) {
    // Reshare via /v2/shares — image not supported on reshares
    const body = {
      owner: author,
      resharedShare: reshareUrn,
      text: { text },
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

  const shareContent = mediaAsset
    ? {
        shareCommentary: { text },
        shareMediaCategory: mediaCategory,
        media: [{ status: "READY", media: mediaAsset }],
      }
    : {
        shareCommentary: { text },
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

async function run() {
  const schedule = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
  const now = Date.now();
  const due = schedule.filter(p =>
    p.date === today && p.approved === true && (
      p.status === "scheduled" ||
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
      if (post.profile === "company" || post.profile === "group") {
        console.log(`⏭ Skipped ${post.id} — posted manually`);
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

      const imagePath = !reshareUrn ? `${VISUALS_DIR}${post.id}.jpg` : null;
      const videoPath = !reshareUrn ? `${VISUALS_DIR}${post.id}.mp4` : null;
      const hasImage = imagePath && existsSync(imagePath);
      const hasVideo = videoPath && existsSync(videoPath);
      if (hasImage) console.log(`  ↳ Image found: ${post.id}.jpg`);
      if (hasVideo) console.log(`  ↳ Video found: ${post.id}.mp4`);

      console.log(`Posting ${post.id} as ${post.profile}${reshareUrn ? ' (reshare)' : ''}${hasImage ? ' + image' : ''}${hasVideo ? ' + video' : ''}...`);
      const linkedInId = await postToLinkedIn(post.profile, post.copy, reshareUrn, hasImage ? imagePath : null, hasVideo ? videoPath : null);
      post.status = "published";
      post.linkedInId = linkedInId;
      post.publishedAt = new Date().toISOString();
      updateCampaignStatus(post.id, "published");
      console.log(`✓ Published: ${post.id} — LinkedIn ID: ${linkedInId}`);
    } catch (e) {
      post.status = "failed";
      post.error = e.message;
      post.retryAfter = Date.now() + 3600000; // retry in 1 hour
      console.error(`✗ Failed: ${post.id} — ${e.message}`);
    }
  }

  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  console.log("Done.");
}

run();
