// Canvas Messenger: a local web app for sending one Canvas Inbox message
// (or a no-reply announcement) to several courses at once.
// Requires Node 18+ (uses built-in fetch). No npm install needed.

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- config (.env next to this file, or real environment variables) ----
function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const PORT = Number(process.env.PORT || 3000);

if (!BASE || !TOKEN) {
  console.error("Missing CANVAS_BASE_URL or CANVAS_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ---- Canvas API helpers ----
async function canvas(method, apiPath, form) {
  const url = apiPath.startsWith("http") ? apiPath : `${BASE}/api/v1${apiPath}`;
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (form) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = form.toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && data.errors ? JSON.stringify(data.errors) : String(text).slice(0, 300);
    throw new Error(`Canvas ${res.status}: ${msg}`);
  }
  return { data, link: res.headers.get("link") || "" };
}

// Follows Canvas pagination (Link: <...>; rel="next").
async function canvasGetAll(apiPath) {
  let out = [];
  let next = apiPath;
  while (next) {
    const { data, link } = await canvas("GET", next);
    out = out.concat(data);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

async function listCourses() {
  const courses = await canvasGetAll(
    "/courses?enrollment_type=teacher&enrollment_state=active&state[]=available&include[]=total_students&include[]=term&per_page=100"
  );
  return courses
    .filter((c) => c && c.id && c.name)
    .map((c) => ({
      id: c.id,
      name: c.name,
      code: c.course_code || "",
      term: (c.term && c.term.name) || "",
      students: c.total_students ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// audience: "students" | "teachers" | "tas" | "everyone"
function recipientFor(courseId, audience) {
  return audience === "everyone" ? `course_${courseId}` : `course_${courseId}_${audience}`;
}

async function sendToCourse(courseId, { subject, body, audience, mode }) {
  const form = new URLSearchParams();
  form.append("recipients[]", recipientFor(courseId, audience));
  form.append("subject", subject);
  form.append("body", body);
  form.append("context_code", `course_${courseId}`);
  form.append("force_new", "true");
  form.append("group_conversation", "true");
  if (mode === "individual") {
    // One private copy per student; replies come back only to you.
    form.append("bulk_message", "true");
    form.append("mode", "async");
  }
  await canvas("POST", "/conversations", form);
}

function toHtml(text) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.split(/\r?\n/).map((l) => `<p>${l || "&nbsp;"}</p>`).join("");
}

// Announcement with comments turned off: students get notified but can't reply.
async function announceToCourse(courseId, { subject, body }) {
  const form = new URLSearchParams();
  form.append("title", subject);
  form.append("message", toHtml(body));
  form.append("is_announcement", "true");
  form.append("published", "true");
  form.append("locked", "true");
  const { data } = await canvas("POST", `/courses/${courseId}/discussion_topics`, form);
  if (data && data.id && !data.locked) {
    const lock = new URLSearchParams({ locked: "true" });
    await canvas("PUT", `/courses/${courseId}/discussion_topics/${data.id}`, lock);
  }
}

// ---- HTTP server ----
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}

const AUDIENCES = ["students", "teachers", "tas", "everyone"];

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    }

    if (req.method === "GET" && req.url === "/api/courses") {
      return sendJson(res, 200, { canvas: BASE, courses: await listCourses() });
    }

    if (req.method === "POST" && req.url === "/api/send") {
      const { courseIds, subject, body, audience = "students", mode = "individual" } = await readBody(req);
      if (!Array.isArray(courseIds) || courseIds.length === 0) return sendJson(res, 400, { error: "Pick at least one course." });
      if (!subject || !subject.trim()) return sendJson(res, 400, { error: "Subject is required." });
      if (!body || !body.trim()) return sendJson(res, 400, { error: "Message is required." });
      if (!AUDIENCES.includes(audience)) return sendJson(res, 400, { error: "Unknown audience." });

      const results = [];
      for (const id of courseIds) {
        if (!/^\d+$/.test(String(id))) {
          results.push({ courseId: id, ok: false, error: "Invalid course id" });
          continue;
        }
        try {
          if (mode === "announcement") await announceToCourse(id, { subject: subject.trim(), body });
          else await sendToCourse(id, { subject: subject.trim(), body, audience, mode });
          results.push({ courseId: id, ok: true });
        } catch (e) {
          results.push({ courseId: id, ok: false, error: e.message });
        }
      }
      return sendJson(res, 200, { results });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// Bound to 127.0.0.1 so only this computer can reach it.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Canvas Messenger running at http://localhost:${PORT}  (Canvas: ${BASE})`);
});
