"use client";

import { FormEvent, useMemo, useState } from "react";

type ApiResponse = {
  transcript: string;
  notes: string;
  source: { type: "youtube" | "upload"; videoUrl?: string; fileName?: string };
  debug?: { model: string; estimatedCostUsd: number };
};

type Status = "idle" | "uploading" | "processing" | "done" | "error";

export default function Home() {
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);

  const helperText = useMemo(() => {
    if (status === "uploading") return "Uploading video…";
    if (status === "processing") return "Calling Gemini stub…";
    if (status === "done") return "Complete.";
    return "Paste a YouTube URL or upload an .mp4/.mov/.webm file.";
  }, [status]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!videoUrl.trim() && !file) {
      setError("Provide a YouTube link or choose a video file.");
      return;
    }

    const formData = new FormData();
    if (videoUrl.trim()) formData.append("videoUrl", videoUrl.trim());
    if (file) formData.append("file", file);

    try {
      setStatus(file ? "uploading" : "processing");
      const res = await fetch("/api/process", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Request failed");
      }

      setStatus("processing");
      const data = (await res.json()) as ApiResponse;
      setResult(data);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unexpected error");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 via-white to-zinc-100 text-zinc-900">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 pb-20 pt-12">
        <header className="flex flex-col gap-3">
          <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">
            Video → Gemini → Notes
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Turn videos into transcripts and notes
          </h1>
          <p className="max-w-2xl text-base text-zinc-600">
            Upload an .mp4 (or .mov/.webm) or drop in a YouTube link. The backend
            will hand it to Gemini (stubbed here) and return a transcript plus a
            concise note bundle.
          </p>
        </header>

        <main className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Submit a video</h2>
                <p className="text-sm text-zinc-500">{helperText}</p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  status === "done"
                    ? "bg-emerald-50 text-emerald-700"
                    : status === "processing" || status === "uploading"
                      ? "bg-amber-50 text-amber-700"
                      : status === "error"
                        ? "bg-rose-50 text-rose-700"
                        : "bg-zinc-100 text-zinc-600"
                }`}
              >
                {status === "idle" && "Idle"}
                {status === "uploading" && "Uploading"}
                {status === "processing" && "Processing"}
                {status === "done" && "Ready"}
                {status === "error" && "Error"}
              </span>
            </div>

            <form
              className="mt-6 flex flex-col gap-5"
              onSubmit={handleSubmit}
              aria-label="video submission form"
            >
              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-zinc-800">
                  YouTube link (optional)
                </span>
                <input
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200"
                />
                <span className="text-xs text-zinc-500">
                  If provided, the link takes precedence over an uploaded file.
                </span>
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-zinc-800">
                  Upload video file (optional)
                </span>
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="w-full cursor-pointer rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-sm text-zinc-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:border-zinc-400"
                />
                {file ? (
                  <span className="text-xs text-zinc-600">
                    Selected: {file.name} ({Math.round(file.size / 1024)} KB)
                  </span>
                ) : (
                  <span className="text-xs text-zinc-500">
                    Max preview size limited by server defaults (~4–5 MB unless
                    adjusted).
                  </span>
                )}
              </label>

              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                  disabled={status === "uploading" || status === "processing"}
                >
                  {status === "uploading" || status === "processing"
                    ? "Processing…"
                    : "Send to Gemini (stub)"}
                </button>
                <p className="text-xs text-zinc-500">
                  We do not persist uploads in this stub. Wire storage + Gemini
                  SDK before production.
                </p>
              </div>
            </form>
          </section>

          <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Output</h2>
              {result?.debug?.model && (
                <span className="text-xs text-zinc-500">
                  Model: {result.debug.model}
                </span>
              )}
            </div>

            {!result && (
              <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
                Results will appear here after you submit a video. Expect a
                transcript and a bullet list of notes.
              </div>
            )}

            {result && (
              <div className="flex flex-col gap-4">
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">
                    Transcript
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm text-zinc-800">
                    {result.transcript}
                  </p>
                </div>

                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">
                    Notes
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-800">
                    {result.notes}
                  </pre>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="rounded-full bg-zinc-100 px-3 py-1">
                    Source:{" "}
                    {result.source.type === "youtube"
                      ? result.source.videoUrl
                      : result.source.fileName}
                  </span>
                  {result.debug?.estimatedCostUsd !== undefined && (
                    <span className="rounded-full bg-zinc-100 px-3 py-1">
                      Est. cost: ${result.debug.estimatedCostUsd.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
