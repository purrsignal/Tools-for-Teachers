# Canvas Messenger

A small app that runs on your own computer and sends one Canvas Inbox message, or a no-reply announcement, to several courses at once.

## Setup (one time)

1. Install Node.js 18 or newer from https://nodejs.org (nothing else to install).
2. In Canvas, go to **Account > Settings > Approved Integrations > + New Access Token**, give it a name, and copy the token.
3. In this folder, copy `.env.example` to `.env` and fill in:
   - `CANVAS_BASE_URL`: your Canvas address, e.g. `https://yourschool.instructure.com`
   - `CANVAS_TOKEN`: the token from step 2

## Run

```
cd canvas-messenger
npm start
```

Open http://localhost:3000. Tick the courses, write the subject and message, choose who gets it, then **Review and send**. You'll see a confirmation and a sent/failed line per course.

## Notes

- Only courses where you're a teacher and that are currently active are listed.
- "Separate message to each person" matches Canvas's "Send an individual message to each recipient" option, so replies stay private. Canvas queues these and delivers them over a minute or so. They show up in your Sent folder.
- "One group conversation per course" makes one shared thread per course, where everyone sees everyone's replies.
- "Announcement, no replies" posts a course announcement with comments turned off, so students can't respond. Canvas Inbox messages can't have replies disabled, so this is the way to send a no-reply message. It goes to everyone in the course, and students are notified based on their Canvas notification settings.
- The server listens only on 127.0.0.1, so other computers can't reach it. Your token stays in `.env` on your computer. Don't share that file.
