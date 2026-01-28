"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) {
      return `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
};

type ApiResponse = {
  transcript: string;
  notes: string;
  source: { type: "youtube" | "upload"; videoUrl?: string; fileName?: string };
  debug?: { model: string; estimatedCostUsd: number };
};

type StreamEvent =
  | { type: "status"; phase: string; message: string; detail?: Record<string, unknown> }
  | { type: "result"; data: ApiResponse & { ok: true } }
  | { type: "error"; message: string };

type Status = "idle" | "uploading" | "processing" | "done" | "error";

export default function Home() {
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploadStats, setUploadStats] = useState<{
    loadedBytes: number;
    totalBytes: number;
    percent: number;
    speedMbps: number | null;
    etaSeconds: number | null;
  } | null>(null);
  const [serverLog, setServerLog] = useState<Array<{ message: string; phase: string }>>(
    []
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);

  const uploadEstimateSeconds = useMemo(() => {
    if (!file) return null;
    const estimatedSeconds = Math.ceil(file.size / (2 * 1024 * 1024));
    return Math.max(10, estimatedSeconds);
  }, [file]);

  const helperText = useMemo(() => {
    if (status === "uploading")
      return "Uploading to the server. Keep this tab open while the file transfers.";
    if (status === "processing")
      return "Gemini is working on your video. Longer files can take a few minutes.";
    if (status === "done") return "Complete. Review the transcript and notes.";
    if (status === "error") return "Something went wrong. Check the error below.";
    return "Paste a YouTube URL or upload an .mp4/.mov/.webm file (up to 2 GB).";
  }, [status]);

  const processingPhaseText = useMemo(() => {
    if (status !== "processing") return null;

    if (!file) {
      if (elapsedSeconds < 10) {
        return "Waiting for Gemini to access the YouTube video.";
      }
      if (elapsedSeconds < 40) {
        return "Gemini is reading the video and building a transcript.";
      }
      return "Waiting for Gemini to finish the response.";
    }

    if (elapsedSeconds < 8) {
      return "Waiting for Gemini to accept and prepare the uploaded video.";
    }
    if (elapsedSeconds < 45) {
      return "Gemini is processing the video and extracting the transcript.";
    }
    return "Waiting for Gemini to finish the response.";
  }, [elapsedSeconds, file, status]);

  const uploadPhaseText = useMemo(() => {
    if (status !== "uploading") return null;

    if (!uploadEstimateSeconds) {
      return "Uploading your video to the server.";
    }

    if (elapsedSeconds < uploadEstimateSeconds) {
      const remaining = Math.max(0, uploadEstimateSeconds - elapsedSeconds);
      return `Uploading your video to the server. About ${formatDuration(remaining)} remaining (estimate).`;
    }

    if (elapsedSeconds < uploadEstimateSeconds + 20) {
      return "Upload likely complete. Waiting for Gemini to start processing.";
    }

    if (elapsedSeconds < uploadEstimateSeconds + 90) {
      return "Gemini is processing the video and building the transcript.";
    }

    return "Waiting for Gemini to finish and return the response.";
  }, [elapsedSeconds, status, uploadEstimateSeconds]);

  const statusDetailFallback = useMemo(() => {
    if (status === "uploading") {
      return uploadPhaseText;
    }
    if (status === "processing") {
      return processingPhaseText;
    }
    if (status === "done") {
      return "All set. Your transcript and notes are ready.";
    }
    return null;
  }, [processingPhaseText, status, uploadPhaseText]);

  const statusDetailText = statusDetail ?? statusDetailFallback;

  const serverPhaseLabel = useMemo(() => {
    if (serverLog.length === 0) return null;
    const phase = serverLog[serverLog.length - 1].phase;
    const labels: Record<string, string> = {
      received: "Received",
      processing: "Preparing request",
      uploading: "Uploading to Gemini",
      "upload-complete": "Upload complete",
      "file-processing": "Gemini processing (backoff)",
      "file-active": "File active",
      "generate-start": "Waiting for response",
      "generate-received": "Parsing response",
    };
    return labels[phase] ?? phase;
  }, [serverLog]);

  const phaseLabel = useMemo(() => {
    if (serverPhaseLabel) return serverPhaseLabel;

    if (status === "uploading") {
      if (!uploadEstimateSeconds || elapsedSeconds < uploadEstimateSeconds) {
        return "Uploading";
      }
      if (elapsedSeconds < uploadEstimateSeconds + 20) {
        return "Waiting for processing";
      }
      if (elapsedSeconds < uploadEstimateSeconds + 90) {
        return "Processing";
      }
      return "Waiting for response";
    }

    if (status === "processing") {
      if (elapsedSeconds < 10) return "Waiting for processing";
      if (elapsedSeconds < 40) return "Processing";
      return "Waiting for response";
    }

    if (status === "done") return "Complete";
    if (status === "error") return "Error";
    return null;
  }, [elapsedSeconds, serverPhaseLabel, status, uploadEstimateSeconds]);

  const formattedElapsed = useMemo(() => {
    if (elapsedSeconds <= 0) return null;
    return formatDuration(elapsedSeconds);
  }, [elapsedSeconds]);

  const formattedUploadEstimate = useMemo(() => {
    if (!uploadEstimateSeconds) return null;
    return formatDuration(uploadEstimateSeconds);
  }, [uploadEstimateSeconds]);

  const formattedUploadRemaining = useMemo(() => {
    if (!uploadEstimateSeconds) return null;
    const remaining = Math.max(0, uploadEstimateSeconds - elapsedSeconds);
    return formatDuration(remaining);
  }, [elapsedSeconds, uploadEstimateSeconds]);

  const appendServerLog = (message: string, phase: string) => {
    setServerLog((previous) => [...previous.slice(-4), { message, phase }]);
  };

  useEffect(() => {
    if (status !== "uploading" && status !== "processing") {
      setElapsedSeconds(0);
      return;
    }

    const start = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [status]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setStatusDetail(null);

    if (!videoUrl.trim() && !file) {
      setError("Provide a YouTube link or choose a video file.");
      return;
    }

    const formData = new FormData();
    if (videoUrl.trim()) formData.append("videoUrl", videoUrl.trim());
    if (file) formData.append("file", file);

    try {
      setStatus(file ? "uploading" : "processing");
      setUploadStats(null);
      setServerLog([]);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/process");
      xhr.responseType = "text";

      const uploadStart = Date.now();
      let lastResponseIndex = 0;
      let responseBuffer = "";
      let hasResult = false;
      let hadError = false;

      const handleStreamEvent = (event: StreamEvent) => {
        if (event.type === "status") {
          setStatus((previous) => (previous === "uploading" ? "processing" : previous));
          setStatusDetail(event.message);
          appendServerLog(event.message, event.phase);
          return;
        }

        if (event.type === "result") {
          hasResult = true;
          setStatusDetail("Formatting the transcript and notes for display.");
          setResult(event.data);
          setStatus("done");
          setStatusDetail("Complete. Transcript and notes are ready.");
          return;
        }

        if (event.type === "error") {
          hadError = true;
          setStatus("error");
          setStatusDetail("Request failed before completion.");
          setError(event.message);
        }
      };

      const parseResponseText = () => {
        const chunk = xhr.responseText.slice(lastResponseIndex);
        if (!chunk) return;
        lastResponseIndex = xhr.responseText.length;
        responseBuffer += chunk;

        const lines = responseBuffer.split("\n");
        responseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as StreamEvent;
            handleStreamEvent(parsed);
          } catch {
            // Ignore malformed partial chunks.
          }
        }
      };

      xhr.upload.onprogress = (progressEvent) => {
        if (!progressEvent.lengthComputable) return;
        const now = Date.now();
        const elapsed = Math.max(0.001, (now - uploadStart) / 1000);
        const loaded = progressEvent.loaded;
        const total = progressEvent.total || file?.size || 0;
        const percent = total > 0 ? (loaded / total) * 100 : 0;
        const speedBytesPerSecond = loaded / elapsed;
        const speedMbps = speedBytesPerSecond / (1024 * 1024);
        const remainingBytes = Math.max(0, total - loaded);
        const etaSeconds =
          speedBytesPerSecond > 0 ? Math.round(remainingBytes / speedBytesPerSecond) : null;

        setUploadStats({
          loadedBytes: loaded,
          totalBytes: total,
          percent,
          speedMbps: Number.isFinite(speedMbps) ? speedMbps : null,
          etaSeconds,
        });
      };

      xhr.upload.onload = () => {
        setStatus("processing");
      };

      xhr.onprogress = () => {
        parseResponseText();
      };

      xhr.onload = () => {
        parseResponseText();

        if (xhr.status >= 400) {
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string };
            throw new Error(body.error || "Request failed");
          } catch (error) {
            hadError = true;
            setStatus("error");
            setStatusDetail("Request failed before completion.");
            setError(error instanceof Error ? error.message : "Request failed");
          }
          return;
        }

        if (!hasResult && !hadError) {
          setStatus("error");
          setStatusDetail("Unexpected response from the server.");
          setError("Unexpected response from the server.");
        }
      };

      xhr.onerror = () => {
        hadError = true;
        setStatus("error");
        setStatusDetail("Network error during upload.");
        setError("Network error during upload.");
      };

      xhr.send(formData);
    } catch (err) {
      setStatus("error");
      setStatusDetail("Request failed before completion.");
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
            will hand it to Gemini and return a transcript plus a concise note
            bundle.
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
            {statusDetailText && (
              <div
                className="mt-4 rounded-lg border px-3 py-2 text-sm text-zinc-700 border-zinc-200 bg-zinc-50"
                aria-live="polite"
              >
                <p>{statusDetailText}</p>
                {formattedElapsed && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Elapsed time: {formattedElapsed}
                  </p>
                )}
                {phaseLabel && (
                  <p className="mt-1 text-xs text-zinc-500">Phase: {phaseLabel}</p>
                )}
                {status === "uploading" && formattedUploadEstimate && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Estimated upload time: {formattedUploadEstimate} (assumes ~2
                    MB/s, about {formattedUploadRemaining} remaining)
                  </p>
                )}
                {status === "uploading" && uploadStats && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Upload progress: {uploadStats.percent.toFixed(1)}% (
                    {formatBytes(uploadStats.loadedBytes)} /{" "}
                    {formatBytes(uploadStats.totalBytes)}) | Speed:{" "}
                    {uploadStats.speedMbps ? uploadStats.speedMbps.toFixed(2) : "n/a"} MB/s
                    {uploadStats.etaSeconds !== null
                      ? ` | ETA: ${formatDuration(uploadStats.etaSeconds)}`
                      : ""}
                  </p>
                )}
              </div>
            )}
            {serverLog.length > 0 && (
              <div className="mt-4 rounded-lg border px-3 py-2 text-xs text-zinc-600 border-zinc-200 bg-white">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Server updates
                </p>
                <div className="mt-2 space-y-1">
                  {serverLog.map((entry, index) => (
                    <p key={`${entry.phase}-${index}`}>
                      [{entry.phase}] {entry.message}
                    </p>
                  ))}
                </div>
              </div>
            )}

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
                    Files up to 2 GB are supported; processing time varies with
                    size.
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
                    : "Send to Gemini"}
                </button>
                <p className="text-xs text-zinc-500">
                  Files are streamed directly to Gemini. YouTube URL processing
                  depends on Gemini URL access.
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
