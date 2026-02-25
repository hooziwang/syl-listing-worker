import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { GenerateJobData } from "../queue/jobs.js";
import { GenerationService } from "../services/generation-service.js";
import { RulesService } from "../services/rules-service.js";
import { RedisJobStore } from "../store/job-store.js";

export function createJobRunner(
  env: AppEnv,
  redis: Redis,
  store: RedisJobStore,
  rulesService: RulesService,
  logger: Logger
): Worker<GenerateJobData> {
  const generationService = new GenerationService(env, logger);

  const worker = new Worker<GenerateJobData>(
    env.queueName,
    async (job) => {
      const { job_id: jobId, tenant_id: tenantId, input_markdown: inputMarkdown } = job.data;
      logger.info({ event: "job_started", job_id: jobId, tenant_id: tenantId }, "job started");

      await store.markStatus(jobId, "running");

      try {
        const resolved = await rulesService.resolve(tenantId, undefined);
        const result = await generationService.generate({
          tenantId,
          rulesVersion: resolved.rules_version,
          inputMarkdown
        });
        await store.markSucceeded(jobId, result);
        logger.info({ event: "job_succeeded", job_id: jobId, tenant_id: tenantId }, "job succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        await store.markFailed(jobId, message);
        logger.error({ event: "job_failed", job_id: jobId, tenant_id: tenantId, error: message }, "job failed");
        throw error;
      }
    },
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
