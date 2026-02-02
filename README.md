# VideoToNotes

Turn a YouTube link or uploaded video into a transcript plus concise bullet notes using
Gemini. The UI streams progress updates while the server uploads, processes, and
summarizes your video.

## Features
- Paste a YouTube URL or upload a local video file (.mp4, .mov, .webm).
- Live status updates while Gemini processes the request.
- Transcript + bullet summary output.
- Size guardrails (uploads up to 2 GB).

## Tech Stack
- Next.js App Router + React 19
- Tailwind CSS v4
- Google Gemini via `@google/genai`

## Requirements
- Node.js 18+ (20+ recommended)
- A Gemini API key

## Setup
1) Install dependencies:
```bash
npm install
```

2) Create `.env` in the project root:
```bash
GEMINI_API_KEY=your_key_here
```

3) Start the dev server:
```bash
npm run dev
```

Open `http://localhost:3000` to use the app.

## How It Works
- The UI submits a `multipart/form-data` request to `src/app/api/process/route.ts`.
- The server streams NDJSON status events until the transcript + notes are ready.
- Uploaded files are sent to Gemini Files and then attached to the generation request.

## Project Structure
- `src/app/page.tsx`: main UI
- `src/app/api/process/route.ts`: streaming transcription API
- `src/lib/gemini.ts`: Gemini client + prompt logic

## Notes
- YouTube URLs are validated for basic http(s) formatting; access depends on Gemini.
- The app reports estimated cost as `0.0` today (no pricing integration yet).
