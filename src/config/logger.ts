import pino from "pino";
import type { AppEnv } from "./env.js";

export function createLogger(env: AppEnv) {
  return pino({
    level: env.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      env.nodeEnv === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname"
            }
          }
        : undefined
  });
}
