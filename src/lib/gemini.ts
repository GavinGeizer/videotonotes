import { GoogleGenAI } from "@google/genai";

export type GeminiSource =
  | {
      type: "youtube";
      videoUrl: string;
    }
  | {
      type: "upload";
      file: Blob;
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

const GEMINI_MODEL = "gemini-1.5-flash";

function buildPrompt(source: GeminiSource) {
  if (source.type === "youtube") {
    return [
      "You are a transcription assistant. If you cannot access the video contents for the URL",
      "below, respond with a single JSON object that includes an empty transcript and notes plus",
      "a brief message explaining that the URL cannot be accessed.",
      `Video URL: ${source.videoUrl}`,
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
}

function parseGeminiText(rawText: string) {
  try {
    const parsed = JSON.parse(rawText) as { transcript?: string; notes?: string[] };
    return {
      transcript: parsed.transcript?.trim() || "",
      notes: parsed.notes?.map((note) => `• ${note}`)?.join("\n") || "",
    };
  } catch {
    return {
      transcript: rawText.trim(),
      notes: "",
    };
  }
}

function createGeminiClient(apiKey: string) {
  return new GoogleGenAI({ apiKey });
}

async function uploadToGeminiFiles(
  client: GoogleGenAI,
  file: { file: Blob; fileName: string; mimeType: string }
) {
  const uploadedFile = await client.files.upload({
    file: file.file,
    config: {
      displayName: file.fileName,
      mimeType: file.mimeType,
    },
  });

  if (!uploadedFile.uri || !uploadedFile.mimeType) {
    throw new Error("Gemini file upload missing file metadata.");
  }

  return {
    uri: uploadedFile.uri,
    mimeType: uploadedFile.mimeType,
  };
}
export async function transcribeWithGemini(
  source: GeminiSource
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const client = createGeminiClient(apiKey);
  const parts: Array<{ text?: string; fileData?: { mimeType: string; fileUri: string } }> = [
    { text: buildPrompt(source) },
  ];

  if (source.type === "upload") {
    const uploadedFile = await uploadToGeminiFiles(client, {
      file: source.file,
      fileName: source.fileName,
      mimeType: source.mimeType,
    });

    parts.push({
      fileData: {
        mimeType: uploadedFile.mimeType,
        fileUri: uploadedFile.uri,
      },
    });
  }

  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  });

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("Gemini response missing content.");
  }

  const parsed = parseGeminiText(rawText);

  return {
    transcript: parsed.transcript,
    notes: parsed.notes,
    model: GEMINI_MODEL,
    estimatedCostUsd: 0.0,
  };
}
