import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export interface GenerateJobData {
  job_id: string;
  tenant_id: string;
  input_markdown: string;
  candidate_count: number;
}

export function createJobQueue(queueName: string, redis: Redis): Queue<GenerateJobData> {
  return new Queue<GenerateJobData>(queueName, {
    connection: redis
  });
}

export async function enqueueGenerateJob(
  queue: Queue<GenerateJobData>,
  payload: GenerateJobData
): Promise<void> {
  await queue.add("generate_listing", payload, {
    jobId: payload.job_id,
    removeOnComplete: 1000,
    removeOnFail: 1000
  });
}
