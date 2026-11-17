
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { google } from "googleapis";
import "dotenv/config";
import crypto from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "40kb" }));

const allowedOrigin = process.env.FRONTEND_ORIGIN;

app.use(cors({
  origin: allowedOrigin,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return process.env[name];
}

function auth(req, res, next) {
  const value = req.headers.authorization || "";
  const token = value.startsWith("Bearer ")
    ? value.slice(7)
    : "";

  try {
    req.owner = jwt.verify(
      token,
      requireEnv("JWT_SECRET"),
      { issuer: "robert-portfolio" }
    );
    next();
  } catch {
    res.status(401).json({
      error: "Please sign in again."
    });
  }
}

async function buffer(query, variables = {}) {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${requireEnv("BUFFER_API_KEY")}`
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();

  if (!response.ok || payload.errors?.length) {
    throw new Error(
      payload.errors?.[0]?.message ||
      "Buffer API request failed"
    );
  }

  return payload.data;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ============================================
// OWNER LOGIN
// ============================================

app.post("/api/login", loginLimiter, async (req, res) => {
  const password = String(req.body?.password || "");
  const hash = requireEnv("OWNER_PASSWORD_HASH");

  const valid = await bcrypt.compare(password, hash);

  if (!valid) {
    return res.status(401).json({
      error: "Incorrect owner password."
    });
  }

  const token = jwt.sign(
    { role: "owner" },
    requireEnv("JWT_SECRET"),
    {
      expiresIn: "2h",
      issuer: "robert-portfolio",
      audience: "social-studio"
    }
  );

  res.json({
    token,
    expiresIn: 7200
  });
});

// ============================================
// BUFFER CHANNELS
// ============================================

app.get("/api/channels", apiLimiter, auth, async (_req, res) => {
  try {
    const query = `
      query {
        account {
          organizations {
            id
            name
          }
        }
      }
    `;

    const data = await buffer(query);
    const organizations = data.account?.organizations || [];

    if (!organizations.length) {
      return res.json({ channels: [] });
    }

    const orgId =
      process.env.BUFFER_ORGANIZATION_ID ||
      organizations[0].id;

    const result = await buffer(
      `
      query Channels($orgId: OrganizationId!) {
        channels(input: {
          organizationId: $orgId
        }) {
          id
          name
          service
          descriptor
        }
      }
      `,
      { orgId }
    );

    res.json({
      channels: result.channels || []
    });

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================
// BUFFER POSTS
// ============================================

app.get("/api/posts", apiLimiter, auth, async (_req, res) => {
  try {
    const orgs = await buffer(`
      query {
        account {
          organizations {
            id
            name
          }
        }
      }
    `);

    const orgId =
      process.env.BUFFER_ORGANIZATION_ID ||
      orgs.account?.organizations?.[0]?.id;

    if (!orgId) {
      return res.json({ posts: [] });
    }

    const data = await buffer(
      `
      query Posts($orgId: OrganizationId!) {
        posts(
          first: 30,
          input: { organizationId: $orgId }
        ) {
          edges {
            node {
              id
              text
              dueAt
              status
              channelId
            }
          }
        }
      }
      `,
      { orgId }
    );

    const posts = (data.posts?.edges || [])
      .map(e => e.node);

    res.json({ posts });

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/posts", apiLimiter, auth, async (req, res) => {
  try {
    const {
      text,
      channelIds,
      mediaUrl,
      mediaType = "image",
      pinBoardId,
      pinTitle,
      youtubeTitle,
      youtubeCategoryId = "22",
      mode = "queue",
      dueAt
    } = req.body || {};

    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 5000
    ) {
      return res.status(400).json({
        error: "Post text is required (maximum 5,000 characters)."
      });
    }

    if (
      !Array.isArray(channelIds) ||
      channelIds.length < 1 ||
      channelIds.length > 10
    ) {
      return res.status(400).json({
        error: "Select between 1 and 10 channels."
      });
    }

    if (!["image", "video", "none"].includes(mediaType)) {
      return res.status(400).json({
        error: "Invalid media type."
      });
    }

    if (mediaType !== "none" && !mediaUrl) {
      return res.status(400).json({
        error: "Provide a public media URL or select No media."
      });
    }

    if (mediaType === "none" && mediaUrl) {
      return res.status(400).json({
        error: "Choose Image or Video when supplying a media URL."
      });
    }

    if (mediaUrl) {
      let u;
      try {
        u = new URL(mediaUrl);
      } catch {
        return res.status(400).json({
          error: "Media URL is invalid."
        });
      }

      if (u.protocol !== "https:") {
        return res.status(400).json({
          error: "Media must use a public HTTPS URL."
        });
      }
    }

    if (
      typeof pinBoardId !== "string" ||
      pinBoardId.length > 200
    ) {
      return res.status(400).json({
        error: "Invalid Pinterest board service ID."
      });
    }

    if (
      typeof youtubeTitle !== "string" ||
      youtubeTitle.length > 100
    ) {
      return res.status(400).json({
        error: "YouTube title must be 100 characters or fewer."
      });
    }

    if (!["queue", "custom", "now"].includes(mode)) {
      return res.status(400).json({
        error: "Invalid scheduling mode."
      });
    }

    if (
      mode === "custom" &&
      (
        !dueAt ||
        !Number.isFinite(Date.parse(dueAt)) ||
        Date.parse(dueAt) <= Date.now()
      )
    ) {
      return res.status(400).json({
        error: "Choose a valid future publishing time."
      });
    }

    const orgId =
      process.env.BUFFER_ORGANIZATION_ID ||
      (await buffer(`
        query {
          account {
            organizations {
              id
            }
          }
        }
      `)).account.organizations[0].id;

    const channelData = await buffer(
      `
      query Channels($orgId: OrganizationId!) {
        channels(input: {
          organizationId: $orgId
        }) {
          id
          name
          service
        }
      }
      `,
      { orgId }
    );

    const allowed = new Map(
      (channelData.channels || []).map(c => [c.id, c])
    );

    const results = [];

    for (const channelId of channelIds) {
      const channel = allowed.get(channelId);

      if (!channel) {
        results.push({
          channelId,
          error: "Channel not found in your Buffer account."
        });
        continue;
      }

      const service = String(channel.service).toLowerCase();

      const needsMedia = [
        "instagram",
        "tiktok",
        "pinterest",
        "youtube"
      ].includes(service);

      if (needsMedia && !mediaUrl) {
        results.push({
          channelId,
          channelName: channel.name,
          error: `${service} requires media. Add a publicly accessible media URL.`
        });
        continue;
      }

      if (service === "youtube" && mediaType !== "video") {
        results.push({
          channelId,
          channelName: channel.name,
          error: "YouTube publishing requires a video URL."
        });
        continue;
      }

      if (
        service === "pinterest" &&
        (mediaType !== "image" || !pinBoardId)
      ) {
        results.push({
          channelId,
          channelName: channel.name,
          error: "Pinterest requires an image URL and board service ID."
        });
        continue;
      }

      const assets = mediaUrl
        ? [{ [mediaType]: { url: mediaUrl } }]
        : [];

      const metadata = {};

      if (service === "facebook") {
        metadata.facebook = { type: "post" };
      }

      if (service === "instagram") {
        metadata.instagram = {
          type: "post",
          shouldShareToFeed: true
        };
      }

      if (service === "pinterest") {
        metadata.pinterest = {
          boardServiceId: pinBoardId,
          ...(pinTitle ? { title: pinTitle } : {})
        };
      }

      if (service === "youtube") {
        if (!youtubeTitle.trim()) {
          results.push({
            channelId,
            channelName: channel.name,
            error: "YouTube requires a video title."
          });
          continue;
        }

        metadata.youtube = {
          title: youtubeTitle.trim(),
          categoryId: String(youtubeCategoryId || "22")
        };
      }

      const schedule =
        mode === "custom"
          ? "mode: customScheduled, dueAt: $dueAt"
          : mode === "now"
            ? "mode: shareNow"
            : "mode: addToQueue";

      const mutation = `
        mutation CreatePost(
          $text: String!,
          $channelId: ChannelId!,
          $assets: [AssetInput!]!,
          $metadata: PostInputMetaData,
          $dueAt: DateTime
        ) {
          createPost(input: {
            text: $text,
            channelId: $channelId,
            schedulingType: automatic,
            ${schedule},
            assets: $assets,
            metadata: $metadata
          }) {
            ... on PostActionSuccess {
              post {
                id
                text
                dueAt
                status
              }
            }
            ... on MutationError {
              message
            }
          }
        }
      `;

      try {
        const variables = {
          text: text.trim(),
          channelId,
          assets,
          metadata,
          ...(mode === "custom" ? { dueAt } : {})
        };

        const data = await buffer(mutation, variables);
        const created = data.createPost;

        if (created?.message) {
          results.push({
            channelId,
            channelName: channel.name,
            error: created.message
          });
        } else {
          results.push({
            channelId,
            channelName: channel.name,
            post: created?.post
          });
        }

      } catch (e) {
        results.push({
          channelId,
          channelName: channel.name,
          error: e.message
        });
      }
    }

    res.json({ results });

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================
// GOOGLE OAUTH
// ============================================

const oauthClient = () => new google.auth.OAuth2(
  requireEnv("GOOGLE_CLIENT_ID"),
  requireEnv("GOOGLE_CLIENT_SECRET"),
  requireEnv("GOOGLE_OAUTH_REDIRECT_URI")
);

// The refresh token is stored in Render Environment Variables.
// Notes themselves are stored in Google Drive.
// Calendar events are stored in Google Calendar.

function getGoogleRefreshToken() {
  return requireEnv("GOOGLE_REFRESH_TOKEN");
}

app.get("/auth/google/start", (req, res) => {
  const widget =
    req.query.widget === "calendar"
      ? "calendar"
      : "notes";

  const state = jwt.sign(
    {
      widget,
      nonce: crypto.randomBytes(16).toString("hex")
    },
    requireEnv("JWT_SECRET"),
    {
      expiresIn: "10m",
      issuer: "robert-portfolio-google"
    }
  );

  const oauth = oauthClient();

  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state,
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/calendar.events"
    ]
  });

  res.redirect(url);
});

// ============================================
// GOOGLE OAUTH CALLBACK
// ============================================

app.get("/auth/google/callback", async (req, res) => {
  try {
    const state = jwt.verify(
      String(req.query.state || ""),
      requireEnv("JWT_SECRET"),
      { issuer: "robert-portfolio-google" }
    );

    if (!req.query.code) {
      throw new Error("Google authorization was cancelled.");
    }

    const oauth = oauthClient();

    const { tokens } = await oauth.getToken(
      String(req.query.code)
    );

    oauth.setCredentials(tokens);

    const userInfo = await google
      .oauth2({
        version: "v2",
        auth: oauth
      })
      .userinfo.get();

    const email = String(
      userInfo.data.email || ""
    ).toLowerCase();

    const allowedEmail = requireEnv(
      "GOOGLE_ALLOWED_EMAIL"
    ).toLowerCase();

    if (!email || email !== allowedEmail) {
      return res.status(403).send(
        "This Google account is not authorized for this portfolio."
      );
    }

    const hadPersistentRefreshToken = Boolean(
      process.env.GOOGLE_REFRESH_TOKEN
    );

    const refreshToken =
      tokens.refresh_token ||
      process.env.GOOGLE_REFRESH_TOKEN ||
      null;

    if (!refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Remove this app from your Google Account permissions and try again."
      );
    }

    // Keep it available for this running process.
    // For persistence across Render restarts, add it once
    // as GOOGLE_REFRESH_TOKEN in Render Environment.

    process.env.GOOGLE_REFRESH_TOKEN = refreshToken;

    if (!hadPersistentRefreshToken) {
      const safeToken = String(refreshToken).replace(
        /[&<>"']/g,
        ch => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[ch])
      );

      return res.status(200).type("html").send(`
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Finish Google Drive setup</title>
        </head>
        <body style="font-family:Arial,sans-serif;max-width:720px;margin:40px auto;padding:20px;line-height:1.5">
          <h2>One-time setup: save your Google refresh token</h2>
          <p>
            Copy the token below. In Render, open your backend service,
            go to Environment, and create a variable named
            <b>GOOGLE_REFRESH_TOKEN</b>. Paste the value there.
          </p>
          <p>
            Keep this token private. Do not put it in GitHub
            or send it in chat.
          </p>
          <textarea id="token" readonly style="width:100%;height:110px;box-sizing:border-box">${safeToken}</textarea>
          <p>
            <button onclick="navigator.clipboard.writeText(document.getElementById('token').value)">
              Copy token
            </button>
          </p>
          <p>
            After adding it to Render, redeploy your service
            and sign in again from your portfolio.
          </p>
        </body>
        </html>
      `);
    }

    const session = jwt.sign(
      {
        role: "google-user",
        email
      },
      requireEnv("JWT_SECRET"),
      {
        expiresIn: "30d",
        issuer: "robert-portfolio-google",
        audience: "portfolio-widgets"
      }
    );

    const frontend = requireEnv("FRONTEND_ORIGIN");

    res.redirect(
      `${frontend}/portfolio/?google_auth=${encodeURIComponent(session)}&widget=${state.widget}`
    );

  } catch (e) {
    res.status(400).send(
      `Google sign-in failed: ${String(
        e.message || "Please try again."
      )}`
    );
  }
});

// ============================================
// GOOGLE SESSION AUTHENTICATION
// ============================================

function googleSession(req, res, next) {
  const value = req.headers.authorization || "";

  try {
    const token = value.startsWith("Bearer ")
      ? value.slice(7)
      : "";

    req.googleSession = jwt.verify(
      token,
      requireEnv("JWT_SECRET"),
      {
        issuer: "robert-portfolio-google",
        audience: "portfolio-widgets"
      }
    );

    if (
      req.googleSession.email !==
      requireEnv("GOOGLE_ALLOWED_EMAIL").toLowerCase()
    ) {
      throw new Error("Not authorized");
    }

    next();

  } catch {
    res.status(401).json({
      error: "Please connect your Google account again."
    });
  }
}

async function googleAuth() {
  const oauth = oauthClient();

  oauth.setCredentials({
    refresh_token: getGoogleRefreshToken()
  });

  return oauth;
}

// ============================================
// GOOGLE DRIVE NOTES
// ============================================

async function driveNotesFile(authClient) {
  const drive = google.drive({
    version: "v3",
    auth: authClient
  });

  const found = await drive.files.list({
    q: "name='portfolio-notes.json' and trashed=false",
    spaces: "drive",
    fields: "files(id,name)",
    pageSize: 10
  });

  return {
    drive,
    file: found.data.files?.[0] || null
  };
}

// Get saved notes
app.get(
  "/api/notes",
  apiLimiter,
  googleSession,
  async (_req, res) => {
    try {
      const authClient = await googleAuth();
      const { drive, file } = await driveNotesFile(authClient);

      if (!file) {
        return res.json({ text: "" });
      }

      const response = await drive.files.get(
        {
          fileId: file.id,
          alt: "media"
        },
        {
          responseType: "text"
        }
      );

      let data = {};

      try {
        data = JSON.parse(response.data || "{}");
      } catch {
        data = {};
      }

      res.json({
        text:
          typeof data.text === "string"
            ? data.text
            : ""
      });

    } catch {
      res.status(502).json({
        error: "Google Drive notes sync failed. Check your Google Drive authorization."
      });
    }
  }
);

// Save notes to Google Drive
app.put(
  "/api/notes",
  apiLimiter,
  googleSession,
  async (req, res) => {
    try {
      const text = req.body?.text;

      if (
        typeof text !== "string" ||
        text.length > 30000
      ) {
        return res.status(400).json({
          error: "Notes must be text up to 30,000 characters."
        });
      }

      const authClient = await googleAuth();

      const { drive, file } =
        await driveNotesFile(authClient);

      const media = {
        mimeType: "application/json",
        body: JSON.stringify({
          text,
          updatedAt: new Date().toISOString()
        })
      };

      if (file) {
        await drive.files.update({
          fileId: file.id,
          media,
          fields: "id,name"
        });
      } else {
        await drive.files.create({
          requestBody: {
            name: "portfolio-notes.json",
            mimeType: "application/json"
          },
          media,
          fields: "id,name"
        });
      }

      res.json({ ok: true });

    } catch {
      res.status(502).json({
        error: "Google Drive could not save your notes. Check your Google authorization."
      });
    }
  }
);

// ============================================
// GOOGLE CALENDAR
// ============================================

// Load events for a month
app.get(
  "/api/calendar",
  apiLimiter,
  googleSession,
  async (req, res) => {
    try {
      const month = String(req.query.month || "");

      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({
          error: "Choose a valid calendar month."
        });
      }

      const [year, mon] = month
        .split("-")
        .map(Number);

      const start = new Date(
        Date.UTC(year, mon - 1, 1)
      );

      const end = new Date(
        Date.UTC(year, mon, 1)
      );

      const calendar = google.calendar({
        version: "v3",
        auth: await googleAuth()
      });

      const result = await calendar.events.list({
        calendarId: "primary",
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250
      });

      const events = (result.data.items || [])
        .map(ev => ({
          id: ev.id,
          title: ev.summary || "(Untitled event)",
          date:
            ev.start?.date ||
            (
              ev.start?.dateTime
                ? ev.start.dateTime.slice(0, 10)
                : ""
            )
        }))
        .filter(ev => ev.id && ev.date);

      res.json({ events });

    } catch {
      res.status(502).json({
        error: "Google Calendar sync failed. Check your Google Calendar authorization."
      });
    }
  }
);

// Add calendar event
app.post(
  "/api/calendar",
  apiLimiter,
  googleSession,
  async (req, res) => {
    try {
      const { date, title } = req.body || {};

      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 120
      ) {
        return res.status(400).json({
          error: "Enter a valid date and event title (maximum 120 characters)."
        });
      }

      const calendar = google.calendar({
        version: "v3",
        auth: await googleAuth()
      });

      const next = new Date(date + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);

      const result = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: title.trim(),
          start: { date },
          end: {
            date: next.toISOString().slice(0, 10)
          }
        }
      });

      res.json({
        ok: true,
        id: result.data.id
      });

    } catch {
      res.status(502).json({
        error: "Google Calendar could not save this event. Check your Google authorization."
      });
    }
  }
);

// Delete calendar event
app.delete(
  "/api/calendar/:id",
  apiLimiter,
  googleSession,
  async (req, res) => {
    try {
      if (
        !/^[a-zA-Z0-9_@.-]{5,300}$/.test(req.params.id)
      ) {
        return res.status(400).json({
          error: "Invalid calendar event."
        });
      }

      const calendar = google.calendar({
        version: "v3",
        auth: await googleAuth()
      });

      await calendar.events.delete({
        calendarId: "primary",
        eventId: req.params.id
      });

      res.json({ ok: true });

    } catch {
      res.status(502).json({
        error: "Google Calendar could not delete this event."
      });
    }
  }
);

// ============================================
// AI ASSISTANT (API key stays in Render Environment)
// ============================================
app.post("/api/assistant", apiLimiter, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt || prompt.length > 6000) {
    return res.status(400).json({ error: "Enter a prompt of up to 6,000 characters." });
  }
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${requireEnv("OPENAI_API_KEY")}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a concise, helpful writing and productivity assistant for a virtual assistant professional. Help with drafting, grammar, summaries, and organizing work." },
          { role: "user", content: prompt }
        ],
        max_tokens: 700
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: data.error?.message || "AI service request failed." });
    }
    res.json({ reply: data.choices?.[0]?.message?.content || "No response was returned." });
  } catch (error) {
    res.status(500).json({ error: error.message || "AI assistant is unavailable." });
  }
});

// ============================================
// NOT FOUND
// ============================================

app.use((_req, res) => {
  res.status(404).json({
    error: "Not found"
  });
});

// ============================================
// START SERVER
// ============================================

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(
    `Social Studio backend listening on ${port}`
  );
});
