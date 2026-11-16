import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { google } from "googleapis";
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "40kb" }));
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors({ origin: allowedOrigin, methods: ["GET","POST","PUT","DELETE"], allowedHeaders: ["Content-Type","Authorization"] }));

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


// Google OAuth is separate from the portfolio owner-password login.
const oauthClient = () => new google.auth.OAuth2(
  requireEnv("GOOGLE_CLIENT_ID"), requireEnv("GOOGLE_CLIENT_SECRET"), requireEnv("GOOGLE_OAUTH_REDIRECT_URI")
);
const tokenStorePath = process.env.GOOGLE_TOKEN_STORE_PATH || (process.env.RENDER ? "/var/data/google-oauth-tokens.json" : path.join(process.cwd(), "data", "google-oauth-tokens.json"));
const encryptToken = value => {
  const key = Buffer.from(requireEnv("OAUTH_TOKEN_ENCRYPTION_KEY"), "hex");
  if (key.length !== 32) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY must be 64 hex characters.");
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
};
const decryptToken = value => {
  const [iv, tag, body] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(requireEnv("OAUTH_TOKEN_ENCRYPTION_KEY"), "hex"), Buffer.from(iv,"hex"));
  decipher.setAuthTag(Buffer.from(tag,"hex"));
  return Buffer.concat([decipher.update(Buffer.from(body,"hex")),decipher.final()]).toString("utf8");
};
async function readGoogleToken() {
  try { return JSON.parse(await fs.readFile(tokenStorePath,"utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
async function writeGoogleToken(refreshToken) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive:true });
  const temp = tokenStorePath + ".tmp";
  await fs.writeFile(temp, JSON.stringify({ refreshToken: encryptToken(refreshToken), updatedAt:new Date().toISOString() }), { mode:0o600 });
  await fs.rename(temp, tokenStorePath);
}
app.get("/auth/google/start", (req,res) => {
  const widget = req.query.widget === "calendar" ? "calendar" : "notes";
  const state = jwt.sign({ widget, nonce:crypto.randomBytes(16).toString("hex") }, requireEnv("JWT_SECRET"), { expiresIn:"10m", issuer:"robert-portfolio-google" });
  const oauth = oauthClient();
  const url = oauth.generateAuthUrl({ access_type:"offline", prompt:"consent", include_granted_scopes:true, state,
    scope:["openid","email","https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/calendar.events"] });
  res.redirect(url);
});
app.get("/auth/google/callback", async (req,res) => {
  try {
    const state = jwt.verify(String(req.query.state || ""), requireEnv("JWT_SECRET"), { issuer:"robert-portfolio-google" });
    if (!req.query.code) throw new Error("Google authorization was cancelled.");
    const oauth = oauthClient();
    const { tokens } = await oauth.getToken(String(req.query.code));
    oauth.setCredentials(tokens);
    const userInfo = await google.oauth2({version:"v2",auth:oauth}).userinfo.get();
    const email = String(userInfo.data.email || "").toLowerCase();
    const allowedEmail = requireEnv("GOOGLE_ALLOWED_EMAIL").toLowerCase();
    if (!email || email !== allowedEmail) return res.status(403).send("This Google account is not authorized for this portfolio.");
    const old = await readGoogleToken();
    const refreshToken = tokens.refresh_token || (old ? decryptToken(old.refreshToken) : null);
    if (!refreshToken) throw new Error("Google did not return a refresh token. Remove this app from your Google Account permissions and try again.");
    await writeGoogleToken(refreshToken);
    const session = jwt.sign({ role:"google-user", email }, requireEnv("JWT_SECRET"), { expiresIn:"30d", issuer:"robert-portfolio-google", audience:"portfolio-widgets" });
    const frontend = requireEnv("FRONTEND_ORIGIN");
    res.redirect(`${frontend}/portfolio/?google_auth=${encodeURIComponent(session)}&widget=${state.widget}`);
  } catch (e) { res.status(400).send(`Google sign-in failed: ${String(e.message || "Please try again.")}`); }
});
function googleSession(req,res,next) {
  const value = req.headers.authorization || "";
  try {
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    req.googleSession = jwt.verify(token, requireEnv("JWT_SECRET"), { issuer:"robert-portfolio-google", audience:"portfolio-widgets" });
    if (req.googleSession.email !== requireEnv("GOOGLE_ALLOWED_EMAIL").toLowerCase()) throw new Error("Not authorized");
    next();
  } catch { res.status(401).json({ error:"Please connect your Google account again." }); }
}
async function googleAuth() {
  const stored = await readGoogleToken();
  if (!stored?.refreshToken) throw new Error("Google account is not connected. Click the widget to sign in.");
  const oauth = oauthClient();
  oauth.setCredentials({ refresh_token:decryptToken(stored.refreshToken) });
  return oauth;
}
async function driveNotesFile(authClient) {
  const drive = google.drive({ version:"v3", auth:authClient });
  const found = await drive.files.list({ q:"name='portfolio-notes.json' and trashed=false", spaces:"drive", fields:"files(id,name)", pageSize:10 });
  return { drive, file:found.data.files?.[0] || null };
}
app.get("/api/google/session", apiLimiter, googleSession, (_req,res)=>res.json({ ok:true }));
app.get("/api/notes", apiLimiter, googleSession, async (_req,res) => {
  try {
    const authClient=await googleAuth(); const {drive,file}=await driveNotesFile(authClient);
    if(!file)return res.json({text:""});
    const response=await drive.files.get({fileId:file.id,alt:"media"},{responseType:"text"});
    let data={};try{data=JSON.parse(response.data||"{}");}catch{}
    res.json({text:typeof data.text==="string"?data.text:""});
  } catch { res.status(502).json({error:"Google Drive notes sync failed. Check your Google Drive authorization."}); }
});
app.put("/api/notes", apiLimiter, googleSession, async (req,res) => {
  try {
    const text=req.body?.text;
    if(typeof text!=="string"||text.length>30000)return res.status(400).json({error:"Notes must be text up to 30,000 characters."});
    const authClient=await googleAuth();const {drive,file}=await driveNotesFile(authClient);
    const media={mimeType:"application/json",body:JSON.stringify({text,updatedAt:new Date().toISOString()})};
    if(file)await drive.files.update({fileId:file.id,media,fields:"id,name"});
    else await drive.files.create({requestBody:{name:"portfolio-notes.json",mimeType:"application/json"},media,fields:"id,name"});
    res.json({ok:true});
  } catch { res.status(502).json({error:"Google Drive could not save your notes. Check your Google authorization."}); }
});
app.get("/api/calendar", apiLimiter, googleSession, async (req,res) => {
  try {
    const month=String(req.query.month||"");if(!/^\d{4}-\d{2}$/.test(month))return res.status(400).json({error:"Choose a valid calendar month."});
    const [year,mon]=month.split("-").map(Number);const start=new Date(Date.UTC(year,mon-1,1)),end=new Date(Date.UTC(year,mon,1));
    const calendar=google.calendar({version:"v3",auth:await googleAuth()});
    const result=await calendar.events.list({calendarId:"primary",timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:true,orderBy:"startTime",maxResults:250});
    const events=(result.data.items||[]).map(ev=>({id:ev.id,title:ev.summary||"(Untitled event)",date:ev.start?.date||(ev.start?.dateTime?ev.start.dateTime.slice(0,10):"")})).filter(ev=>ev.id&&ev.date);
    res.json({events});
  } catch { res.status(502).json({error:"Google Calendar sync failed. Check your Google Calendar authorization."}); }
});
app.post("/api/calendar", apiLimiter, googleSession, async (req,res) => {
  try {
    const {date,title}=req.body||{};if(typeof date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof title!=="string"||!title.trim()||title.length>120)return res.status(400).json({error:"Enter a valid date and event title (maximum 120 characters)."});
    const calendar=google.calendar({version:"v3",auth:await googleAuth()});const next=new Date(date+"T00:00:00Z");next.setUTCDate(next.getUTCDate()+1);
    const result=await calendar.events.insert({calendarId:"primary",requestBody:{summary:title.trim(),start:{date},end:{date:next.toISOString().slice(0,10)}}});res.json({ok:true,id:result.data.id});
  } catch { res.status(502).json({error:"Google Calendar could not save this event. Check your Google authorization."}); }
});
app.delete("/api/calendar/:id", apiLimiter, googleSession, async (req,res) => {
  try {
    if(!/^[a-zA-Z0-9_@.-]{5,300}$/.test(req.params.id))return res.status(400).json({error:"Invalid calendar event."});
    const calendar=google.calendar({version:"v3",auth:await googleAuth()});await calendar.events.delete({calendarId:"primary",eventId:req.params.id});res.json({ok:true});
  } catch { res.status(502).json({error:"Google Calendar could not delete this event."}); }
});
app.use((_req,res)=>res.status(404).json({error:"Not found"}));
const port = Number(process.env.PORT || 3000);
app.listen(port, ()=>console.log(`Social Studio backend listening on ${port}`));
