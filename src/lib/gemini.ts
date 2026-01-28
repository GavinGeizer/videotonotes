import { FileState, GoogleGenAI } from "@google/genai";

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

export type GeminiStatusUpdate =
  | {
      phase: "upload-start";
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    }
  | {
      phase: "upload-complete";
      fileName: string;
      state: FileState | undefined;
    }
  | {
      phase: "file-processing";
      fileName: string;
      attempt: number;
      nextDelayMs: number;
    }
  | {
      phase: "file-active";
      fileName: string;
    }
  | {
      phase: "generate-start";
      model: string;
    }
  | {
      phase: "generate-received";
      model: string;
    };

export type GeminiStatusHandler = (update: GeminiStatusUpdate) => void | Promise<void>;

const GEMINI_MODEL = "gemini-3-flash-preview";
const FILE_ACTIVE_POLL_INITIAL_MS = 100;
const FILE_ACTIVE_POLL_MAX_MS = 20000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFileActive(
  client: GoogleGenAI,
  fileName: string,
  onStatus?: GeminiStatusHandler
) {
  let delayMs = FILE_ACTIVE_POLL_INITIAL_MS;
  let attempt = 1;

  while (true) {
    const file = await client.files.get({ name: fileName });
    const state = file.state;

    if (state === FileState.ACTIVE) {
      await onStatus?.({ phase: "file-active", fileName });
      console.info("[gemini] File is active.", { name: fileName });
      return file;
    }

    if (state !== FileState.PROCESSING) {
      const errorMessage = file.error?.message ?? "Unknown error.";
      console.error("[gemini] File processing failed.", {
        name: fileName,
        state,
        errorMessage,
      });
      throw new Error(
        `Gemini file ${fileName} is in unexpected state: ${state ?? "unknown"} (${errorMessage})`
      );
    }

    console.info("[gemini] File still processing; backing off.", {
      name: fileName,
      attempt,
      nextDelayMs: delayMs,
    });
    await onStatus?.({
      phase: "file-processing",
      fileName,
      attempt,
      nextDelayMs: delayMs,
    });

    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, FILE_ACTIVE_POLL_MAX_MS);
    attempt += 1;
  }
}

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
  file: { file: Blob; fileName: string; mimeType: string; sizeBytes: number },
  onStatus?: GeminiStatusHandler
) {
  await onStatus?.({
    phase: "upload-start",
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  });
  console.info("[gemini] Starting Gemini file upload.", {
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.file.size,
  });

  const uploadedFile = await client.files.upload({
    file: file.file,
    config: {
      displayName: file.fileName,
      mimeType: file.mimeType,
    },
  });

  console.info("[gemini] Gemini file upload complete.", {
    name: uploadedFile.name,
    uri: uploadedFile.uri,
    mimeType: uploadedFile.mimeType,
    state: uploadedFile.state,
  });
  await onStatus?.({
    phase: "upload-complete",
    fileName: uploadedFile.name ?? file.fileName,
    state: uploadedFile.state,
  });

  if (!uploadedFile.uri || !uploadedFile.mimeType || !uploadedFile.name) {
    throw new Error("Gemini file upload missing file metadata.");
  }

  if (uploadedFile.state === FileState.PROCESSING) {
    console.info("[gemini] Waiting for Gemini file to become active.", {
      name: uploadedFile.name,
    });
    await waitForFileActive(client, uploadedFile.name, onStatus);
  } else if (uploadedFile.state !== FileState.ACTIVE) {
    const errorMessage = uploadedFile.error?.message ?? "Unknown error.";
    console.error("[gemini] Gemini file in unexpected state after upload.", {
      name: uploadedFile.name,
      state: uploadedFile.state,
      errorMessage,
    });
    throw new Error(
      `Gemini file ${uploadedFile.name} is in unexpected state: ${uploadedFile.state ?? "unknown"} (${errorMessage})`
    );
  } else {
    console.info("[gemini] Gemini file already active.", { name: uploadedFile.name });
  }

  return {
    uri: uploadedFile.uri,
    mimeType: uploadedFile.mimeType,
    name: uploadedFile.name,
  };
}
export async function transcribeWithGemini(
  source: GeminiSource,
  options?: { onStatus?: GeminiStatusHandler }
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
    const uploadedFile = await uploadToGeminiFiles(
      client,
      {
        file: source.file,
        fileName: source.fileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
      },
      options?.onStatus
    );

    console.info("[gemini] Attaching uploaded file to request.", {
      name: uploadedFile.name,
      uri: uploadedFile.uri,
    });

    parts.push({
      fileData: {
        mimeType: uploadedFile.mimeType,
        fileUri: uploadedFile.uri,
      },
    });
  }

  await options?.onStatus?.({ phase: "generate-start", model: GEMINI_MODEL });
  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    config: {
    },
  });
  await options?.onStatus?.({ phase: "generate-received", model: GEMINI_MODEL });

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
