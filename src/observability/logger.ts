import pino from "pino";

export function createLogger(level: string = "info") {
  return pino({
    level,
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
