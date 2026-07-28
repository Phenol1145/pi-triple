import pino from "pino";

export function createLogger(level: string = "info", destination?: number | string) {
  const dest = destination !== undefined
    ? pino.destination(typeof destination === "number" ? destination : destination)
    : undefined;
  return pino({
    level,
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, dest);
}

export type Logger = pino.Logger;
