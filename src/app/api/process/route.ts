import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGemini, type GeminiSource } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Use multipart/form-data with fields: videoUrl (optional) and file (optional)." },
      { status: 400 }
    );
  }

  const formData = await req.formData();
  const rawUrl = formData.get("videoUrl");
  const file = formData.get("file");

  const videoUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const uploadFile = file instanceof File ? file : null;

  if (!videoUrl && !uploadFile) {
    return NextResponse.json(
      { error: "Provide a YouTube URL or upload a video file (.mp4, .mov, .webm)." },
      { status: 400 }
    );
  }

  let source: GeminiSource;

  if (uploadFile) {
    if (!uploadFile.type.startsWith("video/")) {
      return NextResponse.json(
        { error: `Unsupported file type: ${uploadFile.type || "unknown"}.` },
        { status: 400 }
      );
    }

    // Note: We do not persist the file here. For a real integration, stream to storage (S3, GCS, etc.)
    source = {
      type: "upload",
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
    } catch (err) {
      return NextResponse.json(
        { error: "videoUrl must be a valid http(s) link." },
        { status: 400 }
      );
    }

    source = {
      type: "youtube",
      videoUrl,
    };
  }

  try {
    const result = await transcribeWithGemini(source);
    return NextResponse.json({
      ok: true,
      transcript: result.transcript,
      notes: result.notes,
      source,
      debug: {
        model: result.model,
        estimatedCostUsd: result.estimatedCostUsd,
      },
    });
  } catch (error) {
    console.error("Gemini stub failed", error);
    return NextResponse.json(
      { error: "Failed to process video. Check server logs for details." },
      { status: 500 }
    );
  }
}
