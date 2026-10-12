# Grading Assistant

A small app that runs on your own computer. It pulls the submissions for one Canvas assignment, has Claude draft a score per criterion and brief feedback for each student, lets you review and edit everything, and exports a score sheet (.xlsx).

It only reads from Canvas. It never posts grades or comments; you enter those in SpeedGrader yourself.

## Setup (one time)

1. Install Node.js 18 or newer from https://nodejs.org.
2. Canvas token: in Canvas, go to **Account > Settings > Approved Integrations > + New Access Token** and copy it. (You can reuse the one from Canvas Messenger.)
3. Claude API key: create one at https://platform.claude.com under **Settings > API keys**. API use is billed to that account.
4. In this folder, copy `.env.example` to `.env` and fill in `CANVAS_BASE_URL`, `CANVAS_TOKEN` and `ANTHROPIC_API_KEY`.
5. In this folder, run `npm install` once.

## Run

```
cd grading-assistant
npm start
```

Open http://localhost:3001 (Canvas Messenger uses 3000, so both can run at once).

## How to use it

1. **Assignment.** Pick the course and assignment, then **Load submissions from Canvas**. Load again any time to pick up new or resubmitted work; your grading is kept.
2. **Grading setup.**
   - Upload a rubric and/or a solution (PDF, Word, text, Markdown, Excel or an image), or paste them. Both are optional.
   - Criteria and points: click **Suggest from rubric and solution**, then edit, or type your own. These are what Claude scores and what become the spreadsheet columns.
   - Deductions for lateness, AI use, over-scoping and multiple files are all off by default, so they cost nothing. Tick one to turn it on and say how much, e.g. "10% per day".
   - **Your instructions for grading** apply to every student.
3. **Students.** **Grade ungraded** drafts every student without a grade yet. **Grade selected** grades the ticked students. Click a student to see their scores, Claude's comment for each criterion, the feedback and notes. You can:
   - change any score; the total updates
   - edit the feedback for the student and the notes for you
   - write your comments for grading that student, then **Regrade with my comments**
   - **Copy feedback** to paste into SpeedGrader, and tick **Reviewed**
4. **Export spreadsheet** downloads Student, Submitted (On time, LATE or Missing), one column per criterion, a Total formula, the feedback, your notes and Reviewed.

Everything saves as you type, in the `data` folder, so you can close the app and come back.

## What Claude can read

PDF, Word (.docx, including pictures such as ERDs), images (PNG, JPG, GIF, WebP), Excel (.xlsx), and text or code files (.txt, .md, .sql, .py, .java, .html, .csv and similar), plus text typed into Canvas. Other files, such as .vsdx, .pptx or .zip, and website links are listed in the notes as "review it yourself".

## Notes

- Default model is Claude Opus 5.5. To use another model, add `CLAUDE_MODEL=...` to `.env`.
- If Claude's safety checks decline a request, it's retried automatically on a fallback model. If that also declines, the student shows "Failed" and you grade them yourself.
- The rubric, solution and settings are cached between students, so grading a class costs less than sending them fresh each time.
- The server listens only on 127.0.0.1, so other computers can't reach it. Your token, key and student work stay on your computer apart from what is sent to Claude to grade. Don't share `.env` or the `data` folder.
