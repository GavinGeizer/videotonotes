export type GeminiSource =
  | {
      type: "youtube";
      videoUrl: string;
    }
  | {
      type: "upload";
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    };

export type GeminiResult = {
  transcript: string;
  notes: string;
  model: string;
  estimatedCostUsd: number;
};

/**
 * Placeholder Gemini caller.
 *
 * Swap this stub with a real Gemini SDK call. For example (pseudo-code):
 * const client = new GoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
 * const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });
 * const response = await model.generateContent({ contents: [...] });
 */
export async function transcribeWithGemini(
  source: GeminiSource
): Promise<GeminiResult> {
  // Simulate latency to mimic a remote call.
  await new Promise((resolve) => setTimeout(resolve, 600));

  const descriptor =
    source.type === "youtube"
      ? `YouTube URL: ${source.videoUrl}`
      : `Uploaded file: ${source.fileName} (${Math.round(source.sizeBytes / 1024)} KB)`;

  return {
    transcript: `Stub transcript for ${descriptor}. Replace this with Gemini output.`,
    notes:
      "• Key idea 1\n• Key idea 2\n• Action item: Replace stub with real Gemini integration.\n• Next step: Store results or stream tokens as needed.",
    model: "gemini-1.5-flash (stub)",
    estimatedCostUsd: 0.00,
  };
}
