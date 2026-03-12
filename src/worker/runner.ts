import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { GenerateJobData } from "../queue/jobs.js";
import { GenerationService, InputValidationError } from "../services/generation-service.js";
import { RulesService } from "../services/rules-service.js";
import { RedisJobStore } from "../store/job-store.js";
import { RedisTraceStore } from "../store/trace-store.js";

type GenerationServiceFactory = (
  env: AppEnv,
  logger: Logger,
  traceStore: RedisTraceStore,
  context: {
    tenantId: string;
    jobId: string;
  },
  abortSignal: AbortSignal
) => Pick<GenerationService, "generate">;

class JobCancelledError extends Error {
  constructor(message = "job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function createGenerationService(
  env: AppEnv,
  logger: Logger,
  traceStore: RedisTraceStore,
  context: {
    tenantId: string;
    jobId: string;
  },
  abortSignal: AbortSignal
): GenerationService {
  return new GenerationService(env, logger, traceStore, context, abortSignal);
}

export function createJobProcessor(
  env: AppEnv,
  store: RedisJobStore,
  traceStore: RedisTraceStore,
  rulesService: RulesService,
  logger: Logger,
  generationServiceFactory: GenerationServiceFactory = createGenerationService
) {
  return async (job: Job<GenerateJobData>) => {
    const { job_id: jobId, tenant_id: tenantId, input_markdown: inputMarkdown, input_filename: inputFilename } = job.data;
    const jobLogger = logger.child({ tenant_id: tenantId, job_id: jobId });
    const maxAttempts = typeof job.opts.attempts === "number" && job.opts.attempts > 0 ? job.opts.attempts : 1;
    const appendTrace = async (
      event: string,
      level: "info" | "warn" | "error" = "info",
      payload?: Record<string, unknown>
    ): Promise<void> => {
      try {
        await traceStore.append({
          ts: new Date().toISOString(),
          source: "runner",
          event,
          level,
          tenant_id: tenantId,
          job_id: jobId,
          payload
        });
      } catch (error) {
        jobLogger.warn(
          { event: "trace_append_failed", trace_event: event, error: error instanceof Error ? error.message : String(error) },
          "trace append failed"
        );
      }
    };
    const started = Date.now();
    const currentAttempt = job.attemptsMade + 1;
    const cancelController = new AbortController();
    let stopCancelWatcher = false;
    const cancelWatcher = (async () => {
      while (!stopCancelWatcher && !cancelController.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (stopCancelWatcher || cancelController.signal.aborted) {
          break;
        }
        try {
          const requested = await store.isCancelRequested(jobId);
          if (requested) {
            cancelController.abort(new JobCancelledError("job cancelled by user"));
            break;
          }
        } catch (error) {
          jobLogger.warn(
            {
              event: "cancel_watch_failed",
              error: error instanceof Error ? error.message : String(error)
            },
            "cancel watch failed"
          );
        }
      }
    })();
    const generationService = generationServiceFactory(
      env,
      jobLogger,
      traceStore,
      {
        tenantId,
        jobId
      },
      cancelController.signal
    );

    const markCancelled = async (reason: string): Promise<void> => {
      await store.markCancelled(jobId, reason);
      jobLogger.warn(
        {
          event: "job_cancelled",
          duration_ms: Date.now() - started,
          reason
        },
        "job cancelled"
      );
      await appendTrace("job_cancelled", "warn", {
        duration_ms: Date.now() - started,
        reason
      });
    };
    jobLogger.info(
      {
        event: "job_started",
        queue_job_id: job.id,
        queue_attempt: currentAttempt,
        queue_max_attempts: maxAttempts,
        input_chars: inputMarkdown.length,
        input_filename: inputFilename || undefined
      },
      "job started"
    );

    await store.markStatus(jobId, "running");
    await appendTrace("job_started", "info", {
      queue_job_id: job.id ?? "",
      queue_attempt: currentAttempt,
      queue_max_attempts: maxAttempts,
      input_chars: inputMarkdown.length,
      input_filename: inputFilename || undefined
    });

    try {
      if (await store.isCancelRequested(jobId)) {
        await markCancelled("任务在开始执行前已取消");
        return;
      }
      const resolved = await rulesService.resolve(tenantId, undefined);
      jobLogger.info({ event: "job_rules_resolved", rules_version: resolved.rules_version }, "job rules resolved");
      await appendTrace("job_rules_resolved", "info", { rules_version: resolved.rules_version });
      if (await store.isCancelRequested(jobId)) {
        cancelController.abort(new JobCancelledError("job cancelled by user"));
        await markCancelled("任务在规则解析后被取消");
        return;
      }
      const result = await generationService.generate({
        jobId,
        tenantId,
        rulesVersion: resolved.rules_version,
        inputMarkdown,
        inputFilename
      });
      await store.markSucceeded(jobId, result);
      jobLogger.info(
        {
          event: "job_succeeded",
          duration_ms: Date.now() - started,
          result_timing_ms: result.timing_ms,
          en_chars: result.en_markdown.length,
          cn_chars: result.cn_markdown.length
        },
        "job succeeded"
      );
      await appendTrace("job_succeeded", "info", {
        duration_ms: Date.now() - started,
        result_timing_ms: result.timing_ms,
        en_chars: result.en_markdown.length,
        cn_chars: result.cn_markdown.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      const cancelled = cancelController.signal.aborted || await store.isCancelRequested(jobId);
      if (cancelled) {
        await markCancelled("任务被用户取消");
        return;
      }
      if (error instanceof InputValidationError) {
        await store.markFailed(jobId, message);
        jobLogger.error(
          {
            event: "job_failed",
            duration_ms: Date.now() - started,
            error: message,
            final_attempt: true,
            input_validation: true
          },
          "job failed"
        );
        await appendTrace("job_failed", "error", {
          duration_ms: Date.now() - started,
          error: message,
          final_attempt: true,
          input_validation: true
        });
        return;
      }
      const finalAttempt = currentAttempt >= maxAttempts;
      if (finalAttempt) {
        await store.markFailed(jobId, message);
        jobLogger.error(
          { event: "job_failed", duration_ms: Date.now() - started, error: message, final_attempt: true },
          "job failed"
        );
        await appendTrace("job_failed", "error", {
          duration_ms: Date.now() - started,
          error: message,
          final_attempt: true
        });
      } else {
        await store.markStatus(jobId, "retrying");
        jobLogger.warn(
          {
            event: "job_retry_scheduled",
            duration_ms: Date.now() - started,
            error: message,
            attempt: currentAttempt,
            max_attempts: maxAttempts,
            next_attempt: currentAttempt + 1
          },
          "job retry scheduled"
        );
        await appendTrace("job_retry_scheduled", "warn", {
          duration_ms: Date.now() - started,
          error: message,
          attempt: currentAttempt,
          max_attempts: maxAttempts,
          next_attempt: currentAttempt + 1
        });
      }
      throw error;
    } finally {
      stopCancelWatcher = true;
      await cancelWatcher;
    }
  };
}

export function createJobRunner(
  env: AppEnv,
  redis: Redis,
  store: RedisJobStore,
  traceStore: RedisTraceStore,
  rulesService: RulesService,
  logger: Logger
): Worker<GenerateJobData> {
  const worker = new Worker<GenerateJobData>(
    env.queueName,
    createJobProcessor(env, store, traceStore, rulesService, logger),
    {
      connection: redis,
      concurrency: env.workerConcurrency
    }
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        event: "worker_job_failed",
        job_id: job?.data?.job_id,
        tenant_id: job?.data?.tenant_id,
        error: error.message
      },
      "worker job failed"
    );
  });

  return worker;
}
