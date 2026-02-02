import { createLogger, type Logger, serializeError } from "./logger";

export type TelemetryContext = {
  requestId?: string;
  route?: string;
  userAgent?: string | null;
};

export type TelemetryEvent = {
  name: string;
  data?: Record<string, unknown>;
  context?: TelemetryContext;
};

const isTelemetryEnabled = () => process.env.TELEMETRY_ENABLED !== "false";

export const trackEvent = (
  name: string,
  data?: Record<string, unknown>,
  context?: TelemetryContext,
  logger?: Logger
) => {
  if (!isTelemetryEnabled()) return;
  const telemetryLogger =
    logger ?? createLogger({ scope: "telemetry", requestId: context?.requestId });
  telemetryLogger.info("telemetry_event", {
    name,
    ...data,
    ...context,
  });
};

export async function trackSpan<T>(
  name: string,
  fn: () => Promise<T>,
  options?: {
    data?: Record<string, unknown>;
    context?: TelemetryContext;
    logger?: Logger;
  }
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    trackEvent(
      name,
      { ...options?.data, durationMs: Math.round(performance.now() - start), outcome: "success" },
      options?.context,
      options?.logger
    );
    return result;
  } catch (error) {
    trackEvent(
      name,
      {
        ...options?.data,
        durationMs: Math.round(performance.now() - start),
        outcome: "error",
        error: serializeError(error),
      },
      options?.context,
      options?.logger
    );
    throw error;
  }
}
