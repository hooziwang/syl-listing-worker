import type { AuthService } from "../auth/service.js";
import type { AppEnv } from "../config/env.js";
import type { LLMHealthService } from "../services/llm-health.js";
import type { RulesService } from "../services/rules-service.js";
import type { RedisJobStore } from "../store/job-store.js";
import type { Queue } from "bullmq";
import type { GenerateJobData } from "../queue/jobs.js";

export interface ApiContext {
  env: AppEnv;
  authService: AuthService;
  llmHealthService: LLMHealthService;
  rulesService: RulesService;
  jobStore: RedisJobStore;
  queue: Queue<GenerateJobData>;
}
