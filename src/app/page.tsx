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
  notes: string[];
  source: { type: "youtube" | "upload"; videoUrl?: string; fileName?: string };
  debug?: { model: string; estimatedCostUsd: number };
  rawResponse?: string;
};

type Status = "idle" | "uploading" | "processing" | "done" | "error";
type GeminiFile = {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
  error?: { message?: string };
};

const GEMINI_MODEL = "gemini-3-flash-preview";
const FILE_ACTIVE_POLL_INITIAL_MS = 100;
const FILE_ACTIVE_POLL_MAX_MS = 20000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = (source: ApiResponse["source"]) => {
  if (source.type === "youtube") {
    return [
      "You are a transcription assistant. If you cannot access the video contents for the URL",
      "below, respond with a single JSON object that includes an empty transcript and notes plus",
      "a brief message explaining that the URL cannot be accessed.",
      `Video URL: ${source.videoUrl ?? ""}`,
      "",
      "Respond with JSON in this format:",
      '{"transcript":"...","notes":["...","..."]}',
    ].join("\n");
  }

  return [
    "Transcribe the attached video and summarize it into bullet notes.",
    "Respond with JSON in this format:",
    '{"transcript":"...","notes":["...","..."]}',
  ].join("\n");
};

const stripCodeFence = (rawText: string) =>
  rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

const normalizeNotes = (notes: unknown): string[] => {
  if (Array.isArray(notes)) {
    return notes.map((note) => String(note).trim()).filter(Boolean);
  }
  if (typeof notes === "string") {
    return notes
      .split("\n")
      .map((line) => line.replace(/^[-•\s]+/, "").trim())
      .filter(Boolean);
  }
  return [];
};

const parseGeminiText = (rawText: string) => {
  const cleanedText = stripCodeFence(rawText);

  const tryParse = (text: string) => {
    const parsed = JSON.parse(text) as { transcript?: string; notes?: unknown };
    return {
      transcript: parsed.transcript?.trim() || "",
      notes: normalizeNotes(parsed.notes),
    };
  };

  try {
    return { ...tryParse(cleanedText), rawResponse: null as string | null };
  } catch {
    try {
      const firstBrace = cleanedText.indexOf("{");
      const lastBrace = cleanedText.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const extracted = cleanedText.slice(firstBrace, lastBrace + 1);
        return { ...tryParse(extracted), rawResponse: null as string | null };
      }
    } catch {
      // Fall through to raw response fallback.
    }

    return {
      transcript: cleanedText.trim(),
      notes: [],
      rawResponse: cleanedText.trim(),
    };
  }
};

const startGeminiUpload = async (apiKey: string, file: File) => {
  const startResponse = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": file.size.toString(),
        "X-Goog-Upload-Header-Content-Type": file.type || "application/octet-stream",
      },
      body: JSON.stringify({
        file: {
          display_name: file.name,
        },
      }),
    }
  );

  if (!startResponse.ok) {
    const bodyText = await startResponse.text();
    throw new Error(bodyText || "Failed to start Gemini upload session.");
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini upload URL missing from response.");
  }

  return uploadUrl;
};

const uploadGeminiFile = (
  uploadUrl: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void
) =>
  new Promise<GeminiFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.responseType = "text";

    xhr.upload.onprogress = (progressEvent) => {
      if (!progressEvent.lengthComputable) return;
      onProgress?.(progressEvent.loaded, progressEvent.total || file.size);
    };

    xhr.onload = () => {
      if (xhr.status >= 400) {
        reject(new Error(xhr.responseText || "Gemini upload failed."));
        return;
      }

      try {
        const parsed = JSON.parse(xhr.responseText) as { file?: GeminiFile };
        resolve(parsed.file ?? (parsed as GeminiFile));
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("Could not parse Gemini upload response.")
        );
      }
    };

    xhr.onerror = () => {
      reject(new Error("Network error during upload."));
    };

    xhr.setRequestHeader("X-Goog-Upload-Offset", "0");
    xhr.setRequestHeader("X-Goog-Upload-Command", "upload, finalize");
    xhr.send(file);
  });

const waitForGeminiFileActive = async (
  apiKey: string,
  fileName: string,
  onStatus?: (message: string, phase: string) => void
) => {
  let delayMs = FILE_ACTIVE_POLL_INITIAL_MS;
  let attempt = 1;

  while (true) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`
    );

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(bodyText || "Failed to check Gemini file status.");
    }

    const file = (await response.json()) as GeminiFile;

    if (file.state === "ACTIVE") {
      return file;
    }

    if (file.state && file.state !== "PROCESSING") {
      throw new Error(
        `Gemini file ${fileName} is in unexpected state: ${file.state} (${file.error?.message ?? "Unknown error"})`
      );
    }

    onStatus?.(
      `Gemini file still PROCESSING. Backoff attempt ${attempt}; next check in ${(
        delayMs / 1000
      ).toFixed(1)}s.`,
      "file-processing"
    );
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, FILE_ACTIVE_POLL_MAX_MS);
    attempt += 1;
  }
};

export default function Home() {
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [activeSourceType, setActiveSourceType] = useState<
    "youtube" | "upload" | null
  >(null);
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
  const [activityLog, setActivityLog] = useState<Array<{ message: string; phase: string }>>(
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
      return "Uploading directly to Gemini. Keep this tab open while the file transfers.";
    if (status === "processing")
      return "Gemini is working on your video. Longer files can take a few minutes.";
    if (status === "done") return "Complete. Review the transcript and notes.";
    if (status === "error") return "Something went wrong. Check the error below.";
    return "Paste a YouTube URL or upload an .mp4/.mov/.webm file (up to 2 GB).";
  }, [status]);

  const processingPhaseText = useMemo(() => {
    if (status !== "processing") return null;

    if (activeSourceType !== "upload") {
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
  }, [activeSourceType, elapsedSeconds, status]);

  const uploadPhaseText = useMemo(() => {
    if (status !== "uploading") return null;

    if (!uploadEstimateSeconds) {
      return "Uploading your video to Gemini.";
    }

    if (elapsedSeconds < uploadEstimateSeconds) {
      const remaining = Math.max(0, uploadEstimateSeconds - elapsedSeconds);
      return `Uploading your video to Gemini. About ${formatDuration(remaining)} remaining (estimate).`;
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

  const activityPhaseLabel = useMemo(() => {
    if (activityLog.length === 0) return null;
    const phase = activityLog[activityLog.length - 1].phase;
    const labels: Record<string, string> = {
      received: "Received",
      processing: "Preparing request",
      uploading: "Uploading to Gemini",
      "upload-start": "Starting upload",
      "upload-complete": "Upload complete",
      "file-processing": "Gemini processing (backoff)",
      "file-active": "File active",
      "generate-start": "Waiting for response",
      "generate-received": "Parsing response",
    };
    return labels[phase] ?? phase;
  }, [activityLog]);

  const phaseLabel = useMemo(() => {
    if (activityPhaseLabel) return activityPhaseLabel;

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
  }, [activityPhaseLabel, elapsedSeconds, status, uploadEstimateSeconds]);

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

  const appendActivityLog = (message: string, phase: string) => {
    setActivityLog((previous) => [...previous.slice(-4), { message, phase }]);
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setStatusDetail(null);

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setError("Enter your Gemini API key to continue.");
      return;
    }

    if (!videoUrl.trim() && !file) {
      setError("Provide a YouTube link or choose a video file.");
      return;
    }

    try {
      const trimmedUrl = videoUrl.trim();
      setActiveSourceType(null);
      setStatus(!trimmedUrl && file ? "uploading" : "processing");
      setUploadStats(null);
      setActivityLog([]);
      let source: ApiResponse["source"];
      let fileDataPart:
        | { file_data: { mime_type: string; file_uri: string } }
        | null = null;

      if (trimmedUrl) {
        try {
          const parsed = new URL(trimmedUrl);
          if (!parsed.protocol.startsWith("http")) {
            throw new Error("Invalid protocol");
          }
        } catch {
          throw new Error("videoUrl must be a valid http(s) link.");
        }

        source = {
          type: "youtube",
          videoUrl: trimmedUrl,
        };
        setActiveSourceType("youtube");
      } else if (file) {
        setActiveSourceType("upload");
        if (!file.type.startsWith("video/")) {
          throw new Error(`Unsupported file type: ${file.type || "unknown"}.`);
        }
        if (file.size > 2 * 1024 * 1024 * 1024) {
          throw new Error("File too large. Please upload a video smaller than 2 GB.");
        }

        setStatusDetail("Starting Gemini Files API upload.");
        appendActivityLog("Starting Gemini Files API upload.", "upload-start");

        const uploadUrl = await startGeminiUpload(trimmedKey, file);
        const uploadStart = Date.now();
        const uploadedFile = await uploadGeminiFile(uploadUrl, file, (loaded, total) => {
          const now = Date.now();
          const elapsed = Math.max(0.001, (now - uploadStart) / 1000);
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
        });

        if (!uploadedFile.uri || !uploadedFile.mimeType || !uploadedFile.name) {
          throw new Error("Gemini upload response missing file metadata.");
        }

        appendActivityLog("Gemini upload complete.", "upload-complete");

        if (uploadedFile.state === "PROCESSING") {
          setStatusDetail("Waiting for Gemini to finish processing the upload.");
          const activeFile = await waitForGeminiFileActive(
            trimmedKey,
            uploadedFile.name,
            appendActivityLog
          );
          uploadedFile.uri = activeFile.uri || uploadedFile.uri;
          uploadedFile.mimeType = activeFile.mimeType || uploadedFile.mimeType;
        }

        setStatus("processing");
        setStatusDetail("Upload complete. Asking Gemini for transcript.");
        appendActivityLog("Upload complete. Sending generation request.", "generate-start");

        fileDataPart = {
          file_data: {
            mime_type: uploadedFile.mimeType,
            file_uri: uploadedFile.uri,
          },
        };

        source = {
          type: "upload",
          fileName: file.name,
        };
      } else {
        throw new Error("Provide a YouTube link or choose a video file.");
      }

      const prompt = buildPrompt(source);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
          trimmedKey
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  ...(fileDataPart ? [fileDataPart] : []),
                ],
              },
            ],
          }),
        }
      );

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(bodyText || "Gemini request failed.");
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        text?: string;
      };

      const rawText =
        data.text ?? data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      if (!rawText) {
        throw new Error("Gemini response missing content.");
      }

      const parsed = parseGeminiText(rawText);

      setStatusDetail("Formatting the transcript and notes for display.");
      setResult({
        transcript: parsed.transcript,
        notes: parsed.notes,
        source,
        debug: {
          model: GEMINI_MODEL,
          estimatedCostUsd: 0,
        },
        rawResponse: parsed.rawResponse ?? undefined,
      });
      setStatus("done");
      setStatusDetail("Complete. Transcript and notes are ready.");
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
            Upload an .mp4 (or .mov/.webm) or drop in a YouTube link. Your Gemini
            API key stays in the browser and the file uploads straight to the
            Gemini Files API.
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
            {activityLog.length > 0 && (
              <div className="mt-4 rounded-lg border px-3 py-2 text-xs text-zinc-600 border-zinc-200 bg-white">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Activity updates
                </p>
                <div className="mt-2 space-y-1">
                  {activityLog.map((entry, index) => (
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
                  Gemini API key
                </span>
                <input
                  type="password"
                  placeholder="Paste your API key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200"
                />
                <span className="text-xs text-zinc-500">
                  Used only in this browser tab. It is never sent to the server
                  hosting this app.
                </span>
              </label>

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
                  {result.notes.length > 0 ? (
                    <ul className="mt-2 space-y-2 text-sm text-zinc-800">
                      {result.notes.map((note, index) => (
                        <li key={`${note}-${index}`} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-400" />
                          <span>{note}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-zinc-600">
                      No notes were returned. Check the raw response below if needed.
                    </p>
                  )}
                </div>

                {result.rawResponse && (
                  <details className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Raw response
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap text-xs text-zinc-600">
                      {result.rawResponse}
                    </pre>
                  </details>
                )}

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
