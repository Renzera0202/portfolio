import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { google } from "googleapis";
import "dotenv/config";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "30kb" }));
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors({ origin: allowedOrigin, methods: ["GET","POST","PUT"], allowedHeaders: ["Content-Type","Authorization"] }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
}
function auth(req,res,next) {
  const value = req.headers.authorization || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  try {
    req.owner = jwt.verify(token, requireEnv("JWT_SECRET"), { issuer: "robert-portfolio" });
    next();
  } catch { res.status(401).json({ error: "Please sign in again." }); }
}

function googleDriveClient() {
  const oauth2 = new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET")
  );
  oauth2.setCredentials({ refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN") });
  return google.drive({ version: "v3", auth: oauth2 });
}

async function getNotesFile(drive) {
  const result = await drive.files.list({
    q: "name = 'portfolio-notes.json' and trashed = false",
    pageSize: 10,
    fields: "files(id,name)"
  });
  return result.data.files?.[0] || null;
}

async function readDriveNotes(drive, fileId) {
  const result = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );
  const raw = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return JSON.parse(raw || "{}");
}

async function writeDriveNotes(drive, file, notes) {
  const body = JSON.stringify(notes);
  const media = { mimeType: "application/json", body };
  if (file) {
    await drive.files.update({ fileId: file.id, media, fields: "id,name" });
  } else {
    await drive.files.create({
      requestBody: { name: "portfolio-notes.json", mimeType: "application/json" },
      media,
      fields: "id,name"
    });
  }
}

async function buffer(query, variables={}) {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${requireEnv("BUFFER_API_KEY")}` },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.[0]?.message || "Buffer API request failed");
  return payload.data;
}
app.get("/health", (_req,res)=>res.json({ ok:true }));

app.post("/api/login", loginLimiter, async (req,res) => {
  const password = String(req.body?.password || "");
  const hash = requireEnv("OWNER_PASSWORD_HASH");
  const valid = await bcrypt.compare(password, hash);
  if (!valid) return res.status(401).json({ error: "Incorrect owner password." });
  const token = jwt.sign({ role:"owner" }, requireEnv("JWT_SECRET"), { expiresIn:"2h", issuer:"robert-portfolio", audience:"social-studio" });
  res.json({ token, expiresIn: 7200 });
});


app.get("/api/notes", apiLimiter, auth, async (_req,res) => {
  try {
    const drive = googleDriveClient();
    const file = await getNotesFile(drive);
    if (!file) return res.json({ exists: false, text: "", color: "#fff8dc" });
    const data = await readDriveNotes(drive, file.id);
    res.json({
      exists: true,
      text: typeof data.text === "string" ? data.text : "",
      color: /^#[0-9a-fA-F]{6}$/.test(data.color || "") ? data.color : "#fff8dc",
      updatedAt: data.updatedAt || null
    });
  } catch(e) {
    console.error("Google Drive notes read failed:", e.message);
    res.status(502).json({ error: "Could not load notes from Google Drive. Check the Google Drive connection in Render." });
  }
});

app.put("/api/notes", apiLimiter, auth, async (req,res) => {
  try {
    const text = req.body?.text;
    const color = req.body?.color || "#fff8dc";
    if (typeof text !== "string" || text.length > 20000) {
      return res.status(400).json({ error: "Notes must be text and no longer than 20,000 characters." });
    }
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: "Choose a valid note color." });
    }
    const drive = googleDriveClient();
    const file = await getNotesFile(drive);
    const payload = { text, color, updatedAt: new Date().toISOString() };
    await writeDriveNotes(drive, file, payload);
    res.json({ ok: true, updatedAt: payload.updatedAt });
  } catch(e) {
    console.error("Google Drive notes save failed:", e.message);
    res.status(502).json({ error: "Could not save notes to Google Drive. Check the Google Drive connection in Render." });
  }
});

app.get("/api/channels", apiLimiter, auth, async (_req,res) => {
  try {
    const query = `query { account { organizations { id name } } }`;
    const data = await buffer(query);
    const organizations = data.account?.organizations || [];
    if (!organizations.length) return res.json({ channels: [] });
    const orgId = process.env.BUFFER_ORGANIZATION_ID || organizations[0].id;
    const result = await buffer(`query Channels($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name service descriptor } }`, { orgId });
    res.json({ channels: result.channels || [] });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/posts", apiLimiter, auth, async (_req,res) => {
  try {
    const orgs = await buffer(`query { account { organizations { id name } } }`);
    const orgId = process.env.BUFFER_ORGANIZATION_ID || orgs.account?.organizations?.[0]?.id;
    if (!orgId) return res.json({ posts: [] });
    const data = await buffer(`query Posts($orgId: OrganizationId!) { posts(first: 30, input: { organizationId: $orgId }) { edges { node { id text dueAt status channelId } } } }`, { orgId });
    const posts = (data.posts?.edges || []).map(e=>e.node);
    res.json({ posts });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

app.post("/api/posts", apiLimiter, auth, async (req,res) => {
  try {
    const { text, channelIds, mediaUrl, mediaType="image", pinBoardId, pinTitle, youtubeTitle, youtubeCategoryId="22", mode="queue", dueAt } = req.body || {};
    if (typeof text !== "string" || !text.trim() || text.length > 5000) return res.status(400).json({ error:"Post text is required (maximum 5,000 characters)." });
    if (!Array.isArray(channelIds) || channelIds.length < 1 || channelIds.length > 10) return res.status(400).json({ error:"Select between 1 and 10 channels." });
    if (!["image","video","none"].includes(mediaType)) return res.status(400).json({error:"Invalid media type."});
    if (mediaType !== "none" && !mediaUrl) return res.status(400).json({error:"Provide a public media URL or select No media."});
    if (mediaType === "none" && mediaUrl) return res.status(400).json({error:"Choose Image or Video when supplying a media URL."});
    if (mediaUrl) {
      let u; try { u = new URL(mediaUrl); } catch { return res.status(400).json({error:"Media URL is invalid."}); }
      if (u.protocol !== "https:") return res.status(400).json({error:"Media must use a public HTTPS URL."});
    }
    if (typeof pinBoardId !== "string" || pinBoardId.length > 200) return res.status(400).json({error:"Invalid Pinterest board service ID."});
    if (typeof youtubeTitle !== "string" || youtubeTitle.length > 100) return res.status(400).json({error:"YouTube title must be 100 characters or fewer."});
    if (!["queue","custom","now"].includes(mode)) return res.status(400).json({error:"Invalid scheduling mode."});
    if (mode==="custom" && (!dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now())) return res.status(400).json({error:"Choose a valid future publishing time."});

    const channelData = await buffer(`query Channels($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name service } }`, { orgId: process.env.BUFFER_ORGANIZATION_ID || (await buffer(`query { account { organizations { id } } }`)).account.organizations[0].id });
    const allowed = new Map((channelData.channels || []).map(c=>[c.id,c]));
    const results = [];
    for (const channelId of channelIds) {
      const channel = allowed.get(channelId);
      if (!channel) { results.push({ channelId, error:"Channel not found in your Buffer account." }); continue; }
      const service = String(channel.service).toLowerCase();
      const needsMedia = ["instagram","tiktok","pinterest","youtube"].includes(service);
      if (needsMedia && !mediaUrl) { results.push({ channelId, channelName:channel.name, error:`${service} requires media. Add a publicly accessible media URL.` }); continue; }
      if (service === "youtube" && mediaType !== "video") { results.push({ channelId, channelName:channel.name, error:"YouTube publishing requires a video URL." }); continue; }
      if (service === "pinterest" && (mediaType !== "image" || !pinBoardId)) { results.push({ channelId, channelName:channel.name, error:"Pinterest requires an image URL and board service ID." }); continue; }
      const assets = mediaUrl ? [{ [mediaType]: { url: mediaUrl } }] : [];
      const metadata = {};
      if (service === "facebook") metadata.facebook = { type: "post" };
      if (service === "instagram") metadata.instagram = { type: "post", shouldShareToFeed: true };
      if (service === "pinterest") metadata.pinterest = { boardServiceId: pinBoardId, ...(pinTitle?{title:pinTitle}:{}) };
      if (service === "youtube") {
        if (!youtubeTitle.trim()) { results.push({ channelId, channelName:channel.name, error:"YouTube requires a video title." }); continue; }
        metadata.youtube = { title: youtubeTitle.trim(), categoryId: String(youtubeCategoryId || "22") };
      }
      const schedule = mode==="custom" ? `mode: customScheduled, dueAt: $dueAt` : mode==="now" ? `mode: shareNow` : `mode: addToQueue`;
      const mutation = `mutation CreatePost($text: String!, $channelId: ChannelId!, $assets: [AssetInput!]!, $metadata: PostInputMetaData, $dueAt: DateTime) {
        createPost(input: { text: $text, channelId: $channelId, schedulingType: automatic, ${schedule}, assets: $assets, metadata: $metadata }) {
          ... on PostActionSuccess { post { id text dueAt status } }
          ... on MutationError { message }
        }
      }`;
      try {
        const variables = { text:text.trim(), channelId, assets, metadata, ...(mode==="custom"?{dueAt}:{}) };
        const data = await buffer(mutation, variables);
        const created = data.createPost;
        if (created?.message) results.push({ channelId, channelName:channel.name, error:created.message });
        else results.push({ channelId, channelName:channel.name, post:created?.post });
      } catch(e) { results.push({ channelId, channelName:channel.name, error:e.message }); }
    }
    res.json({ results });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

app.use((_req,res)=>res.status(404).json({error:"Not found"}));
const port = Number(process.env.PORT || 3000);
app.listen(port, ()=>console.log(`Social Studio backend listening on ${port}`));
