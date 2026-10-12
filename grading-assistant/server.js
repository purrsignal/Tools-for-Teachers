// Grading Assistant: a local web app that pulls submissions from a Canvas
// assignment, drafts scores and brief feedback with Claude against your rubric
// and solution, lets you review and edit everything, and exports a score sheet.
// It only READS from Canvas. It never posts grades or comments.

const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const ExcelJS = require("exceljs");
const mammoth = require("mammoth");

// ---- config (.env next to this file, or real environment variables) ----
function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const PORT = Number(process.env.PORT || 3001);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const DATA_DIR = path.join(__dirname, "data");

const missing = [];
if (!BASE || BASE.includes("yourschool")) missing.push("CANVAS_BASE_URL");
if (!TOKEN || TOKEN.startsWith("paste-")) missing.push("CANVAS_TOKEN");
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith("paste-")) missing.push("ANTHROPIC_API_KEY");
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Canvas (read-only: this helper can only send GET requests) ----
async function canvasGet(apiPath) {
  const url = apiPath.startsWith("http") ? apiPath : `${BASE}/api/v1${apiPath}`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && data.errors ? JSON.stringify(data.errors) : String(text).slice(0, 300);
    throw new Error(`Canvas ${res.status}: ${msg}`);
  }
  return { data, link: res.headers.get("link") || "" };
}

async function canvasGetAll(apiPath) {
  let out = [];
  let next = apiPath;
  while (next) {
    const { data, link } = await canvasGet(next);
    out = out.concat(data);
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

async function downloadFile(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function listCourses() {
  const courses = await canvasGetAll(
    "/courses?enrollment_type=teacher&enrollment_state=active&state[]=available&include[]=term&per_page=100"
  );
  return courses
    .filter((c) => c && c.id && c.name)
    .map((c) => ({ id: c.id, name: c.name, code: c.course_code || "", term: (c.term && c.term.name) || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listAssignments(courseId) {
  const items = await canvasGetAll(`/courses/${courseId}/assignments?per_page=100&order_by=due_at`);
  return items.map((a) => ({
    id: a.id,
    name: a.name,
    due: a.due_at,
    points: a.points_possible,
    needsGrading: a.needs_grading_count ?? null,
  }));
}

// ---- saved grading jobs (one JSON file per course + assignment) ----
function jobFile(courseId, assignmentId) {
  return path.join(DATA_DIR, `course${courseId}_assignment${assignmentId}.json`);
}
function loadJob(courseId, assignmentId) {
  const f = jobFile(courseId, assignmentId);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  const f = jobFile(job.courseId, job.assignmentId);
  fs.writeFileSync(f + ".tmp", JSON.stringify(job, null, 1));
  fs.renameSync(f + ".tmp", f);
}

function newSetup() {
  return {
    rubric: null,
    solution: null,
    instructions: "",
    criteria: [],
    deductions: {
      late: { on: false, how: "" },
      ai: { on: false, how: "" },
      overscope: { on: false, how: "" },
      multifile: { on: false, how: "" },
    },
  };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pulls the assignment and its submissions; keeps any grading already done.
async function syncFromCanvas(courseId, assignmentId) {
  const [{ data: course }, { data: assignment }, subs] = await Promise.all([
    canvasGet(`/courses/${courseId}`),
    canvasGet(`/courses/${courseId}/assignments/${assignmentId}`),
    canvasGetAll(`/courses/${courseId}/assignments/${assignmentId}/submissions?include[]=user&per_page=100`),
  ]);
  const job = loadJob(courseId, assignmentId) || {
    courseId: Number(courseId),
    assignmentId: Number(assignmentId),
    setup: newSetup(),
    students: [],
  };
  job.courseName = course.name;
  job.assignmentName = assignment.name;
  job.pointsPossible = assignment.points_possible;
  job.dueAt = assignment.due_at;
  job.description = stripHtml(assignment.description);

  const byId = new Map(job.students.map((s) => [s.userId, s]));
  const students = [];
  for (const sub of subs) {
    const u = sub.user || {};
    if (!u.id || u.name === "Test Student") continue;
    const prev = byId.get(u.id) || {};
    const submitted = !!sub.submitted_at && sub.workflow_state !== "unsubmitted";
    const s = {
      ...prev,
      userId: u.id,
      name: u.name || `User ${u.id}`,
      sortableName: u.sortable_name || u.name || "",
      sisId: u.sis_user_id || "",
      submitted,
      submittedAt: sub.submitted_at || null,
      late: !!sub.late,
      secondsLate: sub.seconds_late || 0,
      attempt: sub.attempt || null,
      type: sub.submission_type || null,
      body: sub.body ? stripHtml(sub.body) : "",
      url: sub.url || "",
      files: (sub.attachments || []).map((a) => ({
        id: a.id,
        name: a.display_name || a.filename,
        size: a.size,
        contentType: a["content-type"] || a.content_type || "",
        url: a.url,
      })),
      teacherNotes: prev.teacherNotes || "",
      reviewed: prev.reviewed || false,
    };
    if (prev.grade && prev.gradedAttempt !== s.attempt) s.resubmitted = true;
    students.push(s);
  }
  students.sort((a, b) => a.sortableName.localeCompare(b.sortableName));
  job.students = students;
  saveJob(job);
  return job;
}

// ---- turning files into content Claude can read ----
const TEXT_EXT = /\.(txt|md|sql|csv|tsv|py|java|js|ts|html|htm|css|json|xml|c|cpp|h|cs|rb|php|r|ipynb|log|yaml|yml)$/i;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function docxToBlocks(buf, name) {
  const images = [];
  const result = await mammoth.convertToHtml(
    { buffer: buf },
    {
      convertImage: mammoth.images.imgElement(async (img) => {
        const type = (img.contentType || "").toLowerCase();
        const b64 = await img.read("base64");
        if (Object.values(IMAGE_TYPES).includes(type) && b64.length * 0.75 <= MAX_IMAGE_BYTES) {
          images.push({ type, b64 });
          return { src: "", alt: `[Image ${images.length} in ${name}]` };
        }
        return { src: "", alt: `[Image in ${name} that could not be read: ${type || "unknown type"}]` };
      }),
    }
  );
  const text = stripHtml(result.value.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, "\n$1\n"));
  const blocks = [{ type: "text", text: `=== ${name} (Word document) ===\n${text}` }];
  images.forEach((im, i) => {
    blocks.push({ type: "text", text: `[Image ${i + 1} in ${name}]` });
    blocks.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.b64 } });
  });
  return blocks;
}

async function xlsxToText(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  wb.eachSheet((ws) => {
    parts.push(`--- sheet: ${ws.name} ---`);
    ws.eachRow((row) => {
      parts.push(row.values.slice(1).map((v) => (v && typeof v === "object" ? v.result ?? v.text ?? JSON.stringify(v) : v ?? "")).join("\t"));
    });
  });
  return parts.join("\n");
}

// Returns { blocks, note } for one file. note is set when the file can't be read.
async function fileToBlocks(name, buf) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") {
    return { blocks: [
      { type: "text", text: `=== ${name} (PDF) ===` },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
    ] };
  }
  if (IMAGE_TYPES[ext]) {
    if (buf.length > MAX_IMAGE_BYTES) return { blocks: [], note: `${name} is an image over 5 MB and was not sent to Claude` };
    return { blocks: [
      { type: "text", text: `=== ${name} (image) ===` },
      { type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data: buf.toString("base64") } },
    ] };
  }
  if (ext === "docx") return { blocks: await docxToBlocks(buf, name) };
  if (ext === "xlsx") return { blocks: [{ type: "text", text: `=== ${name} (spreadsheet) ===\n${await xlsxToText(buf)}` }] };
  if (TEXT_EXT.test(name)) return { blocks: [{ type: "text", text: `=== ${name} ===\n${buf.toString("utf8")}` }] };
  return { blocks: [], note: `${name} is a .${ext} file the assistant can't read; review it yourself` };
}

// Rubric or solution uploaded by the teacher: keep PDFs as PDFs, turn the rest into text.
async function prepareReference(name, b64) {
  const buf = Buffer.from(b64, "base64");
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return { name, kind: "pdf", data: b64 };
  if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { name, kind: "text", text: value };
  }
  if (ext === "xlsx") return { name, kind: "text", text: await xlsxToText(buf) };
  if (IMAGE_TYPES[ext]) return { name, kind: "image", media: IMAGE_TYPES[ext], data: b64 };
  return { name, kind: "text", text: buf.toString("utf8") };
}

function referenceBlocks(label, ref) {
  if (!ref) return [{ type: "text", text: `<${label}>None provided.</${label}>` }];
  if (ref.kind === "pdf") return [
    { type: "text", text: `<${label}> is the attached PDF "${ref.name}".` },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: ref.data } },
  ];
  if (ref.kind === "image") return [
    { type: "text", text: `<${label}> is the attached image "${ref.name}".` },
    { type: "image", source: { type: "base64", media_type: ref.media, data: ref.data } },
  ];
  return [{ type: "text", text: `<${label} file="${ref.name}">\n${ref.text}\n</${label}>` }];
}

// ---- Claude ----
const SYSTEM = `You are a grading assistant for a community college instructor. You draft scores and feedback; the instructor reviews and edits everything before anything reaches students.

How to grade:
- Score each criterion in the list you are given, in that order, using the rubric when there is one and the solution as a reference. When the solution says answers may vary, give full credit for a different approach that meets the requirement and is internally consistent.
- Do not take points off twice for the same mistake. If an early error carries forward correctly, deduct for it once.
- Only apply a deduction for lateness, AI-use disclosure, going beyond the assignment's scope, or submitting multiple files when the instructor has turned that deduction on. When a deduction is off, it costs zero points, though you may still mention the fact in instructor notes.
- Points earned must be between 0 and the criterion's points possible.
- If a file could not be read or something needed for a criterion is missing, score what you can see and say so in instructor notes.

Feedback for the student: brief, specific and kind. Two to five sentences, plain text, no headings or bullet points, addressed to the student. Name what was done well and what lost points.
Instructor notes: short notes only the instructor sees, such as unreadable files, suspected copied or AI-generated text, or judgment calls worth a second look. Leave it empty if there is nothing to note.`;

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "feedback", "instructor_notes"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "points_earned", "comment"],
        properties: {
          name: { type: "string" },
          points_earned: { type: "number" },
          comment: { type: "string" },
        },
      },
    },
    feedback: { type: "string" },
    instructor_notes: { type: "string" },
  },
};

const CRITERIA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "points"],
        properties: { name: { type: "string" }, points: { type: "number" } },
      },
    },
  },
};

async function askClaude({ system, content, schema, effort }) {
  const response = await claude.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to grade this submission. Grade it yourself.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off. Try again.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

function assignmentBlock(job) {
  return {
    type: "text",
    text: `<assignment name="${job.assignmentName}" points_possible="${job.pointsPossible ?? "unknown"}">\n${job.description || "(no description in Canvas)"}\n</assignment>`,
  };
}

// Suggests the criteria list (name + points) from the rubric, solution and assignment.
async function suggestCriteria(job) {
  const content = [
    assignmentBlock(job),
    ...referenceBlocks("rubric", job.setup.rubric),
    ...referenceBlocks("solution", job.setup.solution),
    {
      type: "text",
      text: `List the scoring criteria for this assignment, in order, with the points for each. Use the rubric's own criteria and point values when there is a rubric. Otherwise propose 3 to 8 sensible criteria from the assignment and solution. Points should add up to ${job.pointsPossible ?? 100}. Keep each name short (under 40 characters), and leave out anything the rubric says is not graded.`,
    },
  ];
  const out = await askClaude({ system: "You help an instructor set up grading criteria.", content, schema: CRITERIA_SCHEMA, effort: "medium" });
  return out.criteria;
}

const DEDUCTION_LABELS = {
  late: "Late submission",
  ai: "AI use (disclosed or not)",
  overscope: "Going beyond the assignment's scope",
  multifile: "Submitting multiple files",
};

function settingsText(setup) {
  const lines = ["<grading_settings>", "Criteria (score these, in this order):"];
  setup.criteria.forEach((c, i) => lines.push(`${i + 1}. ${c.name} (${c.points} points)`));
  lines.push("", "Deductions:");
  for (const [key, label] of Object.entries(DEDUCTION_LABELS)) {
    const d = setup.deductions[key] || {};
    lines.push(d.on
      ? `- ${label}: ON. Deduct ${d.how ? `as follows: ${d.how}` : "a reasonable amount and explain it in the criterion comment"}. Apply it by lowering the criterion scores, and name the deduction in that criterion's comment.`
      : `- ${label}: OFF. Do not deduct for this.`);
  }
  if (setup.instructions.trim()) lines.push("", "Instructor's grading instructions (follow these):", setup.instructions.trim());
  lines.push("</grading_settings>");
  return lines.join("\n");
}

async function gradeStudent(job, student) {
  const setup = job.setup;
  // Shared prefix: the same for every student, so it is cached between requests.
  const shared = [
    assignmentBlock(job),
    ...referenceBlocks("rubric", setup.rubric),
    ...referenceBlocks("solution", setup.solution),
    { type: "text", text: settingsText(setup), cache_control: { type: "ephemeral" } },
  ];

  const work = [];
  const notes = [];
  if (student.body) work.push({ type: "text", text: `=== Text entered in Canvas ===\n${student.body}` });
  if (student.url) work.push({ type: "text", text: `=== Submitted URL ===\n${student.url}\n(The assistant cannot open links.)` });
  for (const f of student.files) {
    try {
      const { blocks, note } = await fileToBlocks(f.name, await downloadFile(f.url));
      work.push(...blocks);
      if (note) notes.push(note);
    } catch (e) {
      notes.push(`${f.name} could not be downloaded (${e.message})`);
    }
  }
  if (!work.length) throw new Error(notes.length ? notes.join("; ") : "Nothing readable in this submission.");

  const facts = [
    `Files submitted: ${student.files.length}${student.files.length ? ` (${student.files.map((f) => f.name).join(", ")})` : ""}`,
    student.late ? `Submitted late by about ${Math.ceil(student.secondsLate / 86400)} day(s).` : "Submitted on time.",
  ];
  if (notes.length) facts.push(`Files the assistant could not read: ${notes.join("; ")}`);
  if (student.teacherNotes && student.teacherNotes.trim()) facts.push(`Instructor's notes for this student (follow these): ${student.teacherNotes.trim()}`);
  if (student.grade) {
    facts.push(`Your previous draft for this student, which the instructor may have edited: ${JSON.stringify({ criteria: student.grade.criteria.map((c) => ({ name: c.name, points_earned: c.points_earned })), feedback: student.grade.feedback })}`);
  }

  const content = [
    ...shared,
    { type: "text", text: "<student_submission>" },
    ...work,
    { type: "text", text: `</student_submission>\n\n${facts.join("\n")}\n\nGrade this submission.` },
  ];

  const out = await askClaude({ system: SYSTEM, content, schema: GRADE_SCHEMA, effort: "high" });
  const criteria = setup.criteria.map((c, i) => {
    const got = out.criteria[i] || out.criteria.find((x) => x.name === c.name) || {};
    const pts = Math.max(0, Math.min(Number(c.points) || 0, Number(got.points_earned) || 0));
    return { name: c.name, points_possible: Number(c.points) || 0, points_earned: pts, comment: got.comment || "" };
  });
  return {
    criteria,
    feedback: out.feedback.trim(),
    instructorNotes: [out.instructor_notes.trim(), ...notes].filter(Boolean).join(" "),
    gradedAt: new Date().toISOString(),
  };
}

// ---- spreadsheet export ----
async function buildWorkbook(job) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((job.assignmentName || "Grades").replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  const crit = job.setup.criteria;
  const header = [
    "Student", "SIS ID", "Submitted",
    ...crit.map((c) => `${c.name} (${c.points})`),
    `Total (${crit.reduce((a, c) => a + (Number(c.points) || 0), 0)})`,
    "Feedback for student", "Notes for instructor", "Reviewed",
  ];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];

  job.students.forEach((s) => {
    const r = ws.rowCount + 1;
    const status = !s.submitted ? "Missing" : s.late ? "LATE" : "On time";
    const pts = crit.map((c, i) => (s.grade ? s.grade.criteria[i]?.points_earned ?? null : null));
    const first = 4, last = 3 + crit.length;
    const colL = (n) => ws.getColumn(n).letter;
    const total = s.grade && crit.length ? { formula: `SUM(${colL(first)}${r}:${colL(last)}${r})` } : null;
    ws.addRow([
      s.sortableName || s.name, s.sisId, status, ...pts, total,
      s.grade ? s.grade.feedback : "",
      [s.grade ? s.grade.instructorNotes : "", s.teacherNotes].filter(Boolean).join(" | "),
      s.reviewed ? "Yes" : "",
    ]);
  });

  ws.getColumn(1).width = 26;
  ws.getColumn(3).width = 10;
  const fb = 5 + crit.length;
  ws.getColumn(fb).width = 70;
  ws.getColumn(fb + 1).width = 50;
  [fb, fb + 1].forEach((n) => (ws.getColumn(n).alignment = { wrapText: true, vertical: "top" }));
  return wb;
}


// ---- file preview for the side-by-side viewer ----
const FILE_CACHE = path.join(DATA_DIR, "files");
async function cachedDownload(file) {
  fs.mkdirSync(FILE_CACHE, { recursive: true });
  const f = path.join(FILE_CACHE, String(file.id).replace(/\D/g, "") || "x");
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const buf = await downloadFile(file.url);
  fs.writeFileSync(f, buf);
  return buf;
}

const escHtml = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function previewPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
    body { font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:24px 28px; color:#1d2330; background:#fff; }
    img { max-width:100%; height:auto; } table { border-collapse:collapse; margin:8px 0 20px; } td, th { border:1px solid #d0d5dd; padding:3px 8px; font-size:13px; vertical-align:top; }
    pre { white-space:pre-wrap; font:13px/1.5 ui-monospace,Menlo,Consolas,monospace; } h3.sheet { margin-top:24px; } .muted { color:#667085; }
  </style></head><body>${body}</body></html>`;
}

async function xlsxToHtml(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  let out = "";
  wb.eachSheet((ws) => {
    out += `<h3 class="sheet">${escHtml(ws.name)}</h3><table>`;
    ws.eachRow((row) => {
      out += "<tr>" + row.values.slice(1).map((v) => `<td>${escHtml(v && typeof v === "object" ? v.result ?? v.text ?? JSON.stringify(v) : v)}</td>`).join("") + "</tr>";
    });
    out += "</table>";
  });
  return out;
}

// Sends one submitted file (or the text entry) in a form the browser can show.
async function sendPreview(res, student, which, download, downloadHref) {
  // Student files are shown with scripts blocked.
  const SAFE = { "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'", "X-Content-Type-Options": "nosniff" };
  const html = (title, body) => { res.writeHead(200, { ...SAFE, "Content-Type": "text/html; charset=utf-8" }); res.end(previewPage(title, body)); };
  if (which === "text") {
    return html("Text entry", student.body
      ? `<pre style="font-family:inherit;font-size:15px">${escHtml(student.body)}</pre>`
      : student.url ? `<p>Submitted link: <a href="${escHtml(student.url)}" target="_blank" rel="noopener">${escHtml(student.url)}</a></p>` : `<p class="muted">Nothing submitted.</p>`);
  }
  const file = student.files[Number(which)];
  if (!file) return html("Not found", `<p class="muted">File not found.</p>`);
  let buf;
  try { buf = await cachedDownload(file); }
  catch (e) { return html(file.name, `<p>Could not download ${escHtml(file.name)} from Canvas (${escHtml(e.message)}).</p>`); }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (download) {
    res.writeHead(200, { ...SAFE, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${file.name.replace(/["\r\n]/g, "")}"` });
    return res.end(buf);
  }
  if (ext === "pdf") { res.writeHead(200, { "Content-Type": "application/pdf", "X-Content-Type-Options": "nosniff" }); return res.end(buf); }
  if (IMAGE_TYPES[ext]) return html(file.name, `<img src="data:${IMAGE_TYPES[ext]};base64,${buf.toString("base64")}" alt="${escHtml(file.name)}">`);
  if (ext === "docx") {
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return html(file.name, value);
  }
  if (ext === "xlsx") return html(file.name, await xlsxToHtml(buf));
  if (TEXT_EXT.test(file.name)) return html(file.name, `<pre>${escHtml(buf.toString("utf8"))}</pre>`);
  return html(file.name, `<p>This ${escHtml("." + ext)} file can't be shown here.</p><p><a href="${escHtml(downloadHref)}">Download ${escHtml(file.name)}</a> to open it on your computer.</p>`);
}

// ---- HTTP server ----
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Upload too large (60 MB max).")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { const raw = Buffer.concat(chunks).toString("utf8"); resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}

const isId = (v) => /^\d+$/.test(String(v));

function requireJob(q) {
  if (!isId(q.courseId) || !isId(q.assignmentId)) throw Object.assign(new Error("Pick a course and assignment."), { status: 400 });
  const job = loadJob(q.courseId, q.assignmentId);
  if (!job) throw Object.assign(new Error("Load the submissions from Canvas first."), { status: 400 });
  return job;
}

// Strips large file data before sending a job to the browser.
function publicJob(job) {
  const ref = (r) => (r ? { name: r.name, kind: r.kind, size: r.size, uploadedAt: r.uploadedAt, chars: r.kind === "text" ? (r.text || "").trim().length : null } : null);
  return { ...job, setup: { ...job.setup, rubric: ref(job.setup.rubric), solution: ref(job.setup.solution) } };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(u.searchParams);
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    }
    if (req.method === "GET" && u.pathname === "/api/courses") {
      return sendJson(res, 200, { canvas: BASE, courses: await listCourses() });
    }
    if (req.method === "GET" && u.pathname === "/api/assignments") {
      if (!isId(q.courseId)) return sendJson(res, 400, { error: "Invalid course." });
      return sendJson(res, 200, { assignments: await listAssignments(q.courseId) });
    }
    if (req.method === "GET" && u.pathname === "/api/job") {
      if (!isId(q.courseId) || !isId(q.assignmentId)) return sendJson(res, 400, { error: "Invalid ids." });
      const job = loadJob(q.courseId, q.assignmentId);
      return sendJson(res, 200, { job: job ? publicJob(job) : null });
    }
    if (req.method === "POST" && u.pathname === "/api/sync") {
      const { courseId, assignmentId } = await readBody(req);
      if (!isId(courseId) || !isId(assignmentId)) return sendJson(res, 400, { error: "Pick a course and assignment." });
      return sendJson(res, 200, { job: publicJob(await syncFromCanvas(courseId, assignmentId)) });
    }
    if (req.method === "POST" && u.pathname === "/api/reference") {
      const body = await readBody(req);
      const job = requireJob(body);
      if (!["rubric", "solution"].includes(body.field)) return sendJson(res, 400, { error: "Unknown field." });
      if (body.remove) job.setup[body.field] = null;
      else if (body.text != null) {
        if (!String(body.text).trim()) return sendJson(res, 400, { error: "Nothing was pasted." });
        job.setup[body.field] = { name: "pasted text", kind: "text", text: String(body.text) };
      } else {
        if (!body.data) return sendJson(res, 400, { error: "The file was empty." });
        job.setup[body.field] = await prepareReference(String(body.name || "file"), String(body.data));
        job.setup[body.field].size = Math.floor(String(body.data).length * 0.75);
      }
      if (job.setup[body.field]) job.setup[body.field].uploadedAt = new Date().toISOString();
      saveJob(job);
      return sendJson(res, 200, { job: publicJob(job) });
    }
    if (req.method === "POST" && u.pathname === "/api/setup") {
      const body = await readBody(req);
      const job = requireJob(body);
      const s = body.setup || {};
      if (typeof s.instructions === "string") job.setup.instructions = s.instructions;
      if (Array.isArray(s.criteria)) {
        job.setup.criteria = s.criteria
          .map((c) => ({ name: String(c.name || "").trim(), points: Number(c.points) || 0 }))
          .filter((c) => c.name);
      }
      if (s.deductions) {
        for (const k of Object.keys(DEDUCTION_LABELS)) {
          const d = s.deductions[k] || {};
          job.setup.deductions[k] = { on: !!d.on, how: String(d.how || "") };
        }
      }
      saveJob(job);
      return sendJson(res, 200, { job: publicJob(job) });
    }
    if (req.method === "POST" && u.pathname === "/api/suggest-criteria") {
      const job = requireJob(await readBody(req));
      return sendJson(res, 200, { criteria: await suggestCriteria(job) });
    }
    if (req.method === "POST" && u.pathname === "/api/grade") {
      const body = await readBody(req);
      const job = requireJob(body);
      if (!job.setup.criteria.length) return sendJson(res, 400, { error: "Set up the criteria first." });
      const student = job.students.find((s) => s.userId === Number(body.userId));
      if (!student) return sendJson(res, 404, { error: "Student not found." });
      if (!student.submitted) return sendJson(res, 400, { error: "No submission to grade." });
      const grade = await gradeStudent(job, student);
      // Re-read in case the instructor saved edits to other students meanwhile.
      const fresh = loadJob(job.courseId, job.assignmentId);
      const s = fresh.students.find((x) => x.userId === student.userId);
      s.grade = grade;
      s.gradedAttempt = s.attempt;
      s.resubmitted = false;
      s.reviewed = false;
      saveJob(fresh);
      return sendJson(res, 200, { student: s });
    }
    if (req.method === "GET" && u.pathname === "/api/file") {
      const job = requireJob(q);
      const student = job.students.find((x) => x.userId === Number(q.userId));
      if (!student) return sendJson(res, 404, { error: "Student not found." });
      if (q.which !== "text" && !isId(q.which)) return sendJson(res, 400, { error: "Bad file." });
      const dl = `/api/file?courseId=${job.courseId}&assignmentId=${job.assignmentId}&userId=${student.userId}&which=${q.which}&download=1`;
      return await sendPreview(res, student, q.which, q.download === "1", dl);
    }
    if (req.method === "POST" && u.pathname === "/api/student") {
      const body = await readBody(req);
      const job = requireJob(body);
      const s = job.students.find((x) => x.userId === Number(body.userId));
      if (!s) return sendJson(res, 404, { error: "Student not found." });
      const p = body.patch || {};
      if (typeof p.teacherNotes === "string") s.teacherNotes = p.teacherNotes;
      if (typeof p.reviewed === "boolean") s.reviewed = p.reviewed;
      if (s.grade) {
        if (typeof p.feedback === "string") s.grade.feedback = p.feedback;
        if (typeof p.instructorNotes === "string") s.grade.instructorNotes = p.instructorNotes;
        if (Array.isArray(p.points)) {
          p.points.forEach((v, i) => {
            if (s.grade.criteria[i] && v !== "" && v != null && !isNaN(Number(v))) s.grade.criteria[i].points_earned = Number(v);
          });
        }
      }
      saveJob(job);
      return sendJson(res, 200, { student: s });
    }
    if (req.method === "GET" && u.pathname === "/api/export") {
      const job = requireJob(q);
      const wb = await buildWorkbook(job);
      const name = `${job.assignmentName || "grades"}`.replace(/[^\w\- ]+/g, "").trim() || "grades";
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name} grades.xlsx"`,
      });
      await wb.xlsx.write(res);
      return res.end();
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    sendJson(res, e.status || 500, { error: e.message });
  }
});

// Bound to 127.0.0.1 so only this computer can reach it.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Grading Assistant running at http://localhost:${PORT}  (Canvas: ${BASE}, model: ${MODEL})`);
});
