import { NextRequest, NextResponse } from "next/server";
import {
  transcribeWithGemini,
  type GeminiSource,
  type GeminiStatusUpdate,
} from "../../../lib/gemini";
import { createLogger, createRequestId, serializeError } from "../../../lib/logger";
import { trackEvent, trackSpan } from "../../../lib/telemetry";

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
  const requestId = createRequestId();
  const logger = createLogger({
    scope: "api/process",
    requestId,
    baseMeta: { method: req.method },
  });
  const telemetryContext = {
    requestId,
    route: "/api/process",
    userAgent: req.headers.get("user-agent"),
  };

  const contentType = req.headers.get("content-type") || "";
  logger.info("Request received.", { contentType });
  trackEvent("process_request_received", { contentType }, telemetryContext, logger);
  if (!contentType.includes("multipart/form-data")) {
    logger.warn("Unsupported content type.", { contentType });
    trackEvent("process_invalid_content_type", { contentType }, telemetryContext, logger);
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
        logger.warn("Missing video input.");
        trackEvent("process_missing_input", {}, telemetryContext, logger);
        await send({
          type: "error",
          message: "Provide a YouTube URL or upload a video file (.mp4, .mov, .webm).",
        });
        return;
      }

      let source: GeminiSource;

      if (uploadFile) {
        if (!uploadFile.type.startsWith("video/")) {
          logger.warn("Unsupported upload mime type.", { mimeType: uploadFile.type });
          trackEvent(
            "process_invalid_upload_type",
            { mimeType: uploadFile.type },
            telemetryContext,
            logger
          );
          await send({
            type: "error",
            message: `Unsupported file type: ${uploadFile.type || "unknown"}.`,
          });
          return;
        }

        if (uploadFile.size > MAX_UPLOAD_BYTES) {
          logger.warn("Upload exceeds size limit.", {
            sizeBytes: uploadFile.size,
            maxBytes: MAX_UPLOAD_BYTES,
          });
          trackEvent(
            "process_upload_too_large",
            { sizeBytes: uploadFile.size, maxBytes: MAX_UPLOAD_BYTES },
            telemetryContext,
            logger
          );
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
          logger.warn("Invalid video URL supplied.", { videoUrl });
          trackEvent("process_invalid_video_url", { videoUrl }, telemetryContext, logger);
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

      logger.info("Input validated; starting Gemini processing.", {
        sourceType: source.type,
      });
      trackEvent(
        "process_start_gemini",
        { sourceType: source.type },
        telemetryContext,
        logger
      );
      await send({
        type: "status",
        phase: "processing",
        message: "Calling Gemini with the prepared request.",
      });

      const result = await trackSpan(
        "gemini_transcribe",
        () =>
          transcribeWithGemini(source, {
            onStatus: async (update) => {
              await send(mapStatus(update));
            },
            logger: logger.child({ subsystem: "gemini" }),
          }),
        {
          data: { sourceType: source.type },
          context: telemetryContext,
          logger,
        }
      );

      logger.info("Gemini processing complete.", { sourceType: source.type });
      trackEvent("process_success", { sourceType: source.type }, telemetryContext, logger);
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
      logger.error("Gemini request failed.", { error: serializeError(error) });
      trackEvent(
        "process_error",
        { error: serializeError(error) },
        telemetryContext,
        logger
      );
      await send({
        type: "error",
        message: "Failed to process video. Check server logs for details.",
      });
    } finally {
      logger.info("Request stream closed.");
      await writer.close();
    }
  })();

  return response;
}
