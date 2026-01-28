import { NextRequest, NextResponse } from "next/server";
import {
  transcribeWithGemini,
  type GeminiSource,
  type GeminiStatusUpdate,
} from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

type StreamEvent =
  | { type: "status"; phase: string; message: string; detail?: Record<string, unknown> }
  | {
      type: "result";
      data: {
        ok: true;
        transcript: string;
        notes: string;
        source: GeminiSource;
        debug: { model: string; estimatedCostUsd: number };
      };
    }
  | { type: "error"; message: string };

const formatBackoffSeconds = (ms: number) => (ms / 1000).toFixed(1);

function mapStatus(update: GeminiStatusUpdate): StreamEvent {
  switch (update.phase) {
    case "upload-start":
      return {
        type: "status",
        phase: "uploading",
        message: `Server uploading to Gemini: ${update.fileName} (${Math.round(
          update.sizeBytes / (1024 * 1024)
        )} MB).`,
        detail: {
          fileName: update.fileName,
          mimeType: update.mimeType,
          sizeBytes: update.sizeBytes,
        },
      };
    case "upload-complete":
      return {
        type: "status",
        phase: "upload-complete",
        message: `Gemini upload complete. File state: ${update.state ?? "unknown"}.`,
        detail: {
          fileName: update.fileName,
          state: update.state ?? "unknown",
        },
      };
    case "file-processing":
      return {
        type: "status",
        phase: "file-processing",
        message: `Gemini file still PROCESSING. Backoff attempt ${update.attempt}; next check in ${formatBackoffSeconds(
          update.nextDelayMs
        )}s.`,
        detail: {
          fileName: update.fileName,
          attempt: update.attempt,
          nextDelayMs: update.nextDelayMs,
        },
      };
    case "file-active":
      return {
        type: "status",
        phase: "file-active",
        message: "Gemini file is ACTIVE. Sending generation request.",
        detail: { fileName: update.fileName },
      };
    case "generate-start":
      return {
        type: "status",
        phase: "generate-start",
        message: `Gemini generation started (${update.model}). Waiting for response.`,
        detail: { model: update.model },
      };
    case "generate-received":
      return {
        type: "status",
        phase: "generate-received",
        message: "Gemini response received. Parsing output.",
        detail: { model: update.model },
      };
    default:
      return {
        type: "status",
        phase: "update",
        message: "Processing update received.",
      };
  }
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Use multipart/form-data with fields: videoUrl (optional) and file (optional)." },
      { status: 400 }
    );
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: StreamEvent) => {
    await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  const response = new NextResponse(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });

  void (async () => {
    try {
      await send({
        type: "status",
        phase: "received",
        message: "Server received request. Parsing input.",
      });

      const formData = await req.formData();
      const rawUrl = formData.get("videoUrl");
      const file = formData.get("file");

      const videoUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
      const uploadFile = file instanceof File ? file : null;

      if (!videoUrl && !uploadFile) {
        await send({
          type: "error",
          message: "Provide a YouTube URL or upload a video file (.mp4, .mov, .webm).",
        });
        return;
      }

      let source: GeminiSource;

      if (uploadFile) {
        if (!uploadFile.type.startsWith("video/")) {
          await send({
            type: "error",
            message: `Unsupported file type: ${uploadFile.type || "unknown"}.`,
          });
          return;
        }

        if (uploadFile.size > MAX_UPLOAD_BYTES) {
          await send({
            type: "error",
            message: "File too large. Please upload a video smaller than 2 GB.",
          });
          return;
        }

        source = {
          type: "upload",
          file: uploadFile,
          fileName: uploadFile.name,
          mimeType: uploadFile.type || "video/mp4",
          sizeBytes: uploadFile.size,
        };
      } else {
        try {
          // Basic URL validation; real implementation could enforce domain allow-list.
          const parsed = new URL(videoUrl);
          if (!parsed.protocol.startsWith("http")) {
            throw new Error("Invalid protocol");
          }
        } catch {
          await send({
            type: "error",
            message: "videoUrl must be a valid http(s) link.",
          });
          return;
        }

        source = {
          type: "youtube",
          videoUrl,
        };
      }

      await send({
        type: "status",
        phase: "processing",
        message: "Calling Gemini with the prepared request.",
      });

      const result = await transcribeWithGemini(source, {
        onStatus: async (update) => {
          await send(mapStatus(update));
        },
      });

      await send({
        type: "result",
        data: {
          ok: true,
          transcript: result.transcript,
          notes: result.notes,
          source,
          debug: {
            model: result.model,
            estimatedCostUsd: result.estimatedCostUsd,
          },
        },
      });
    } catch (error) {
      console.error("Gemini request failed", error);
      await send({
        type: "error",
        message: "Failed to process video. Check server logs for details.",
      });
    } finally {
      await writer.close();
    }
  })();

  return response;
}
