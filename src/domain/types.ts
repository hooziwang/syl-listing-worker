export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ListingResult {
  en_markdown: string;
  cn_markdown: string;
  validation_report: string[];
  timing_ms: number;
  billing_summary: {
    provider: string;
    model: string;
    note: string;
  };
}

export interface JobRecord {
  id: string;
  tenant_id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  error_message?: string;
  result?: ListingResult;
}

export interface GenerateRequest {
  input_markdown: string;
  candidate_count?: number;
}

export interface RulesResolveResponse {
  up_to_date: boolean;
  rules_version: string;
  manifest_sha256: string;
  download_url: string;
  signature_base64?: string;
  signature_algo?: string;
}
