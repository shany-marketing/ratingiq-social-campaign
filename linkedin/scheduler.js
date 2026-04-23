import { readFileSync, writeFileSync } from "fs";
import { config } from "dotenv";

config();

const SCHEDULE_FILE = new URL("./schedule.json", import.meta.url).pathname;
const CAMPAIGN_FILE = new URL("../index.html", import.meta.url).pathname;

const today = new Date().toISOString().split("T")[0];

async function postToLinkedIn(profile, text) {
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

  const body = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
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
    // Update status in DEFAULT_POSTS for this post id
    const regex = new RegExp(`(id:'${postId}'[^}]*status:)'[^']*'`);
    html = html.replace(regex, `$1'${status}'`);
    writeFileSync(CAMPAIGN_FILE, html);
  } catch (e) {
    console.log(`Note: Could not update campaign file status for ${postId}: ${e.message}`);
  }
}

async function run() {
  const schedule = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
  const due = schedule.filter(p => p.date === today && p.status === "scheduled" && p.approved === true);
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
      console.log(`Posting p${post.id} as ${post.profile}...`);
      const linkedInId = await postToLinkedIn(post.profile, post.copy);
      post.status = "published";
      post.linkedInId = linkedInId;
      post.publishedAt = new Date().toISOString();
      updateCampaignStatus(post.id, "published");
      console.log(`✓ Published: ${post.id} — LinkedIn ID: ${linkedInId}`);
    } catch (e) {
      post.status = "failed";
      post.error = e.message;
      console.error(`✗ Failed: ${post.id} — ${e.message}`);
    }
  }

  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  console.log("Done.");
}

run();
