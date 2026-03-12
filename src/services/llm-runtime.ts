import type { ModelSettings } from "@openai/agents";
import type { ModelProfile } from "../agent-runtime/types.js";
import type { AppEnv } from "../config/env.js";

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/g, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function resolveProviderBaseURL(baseUrl: string, endpointPath: string, endpointSuffix: string): string {
  const base = baseUrl.replace(/\/+$/g, "");
  const endpoint = normalizePath(endpointPath);
  const suffix = normalizePath(endpointSuffix);

  if (!endpoint || endpoint === suffix) {
    return base;
  }
  if (!endpoint.endsWith(suffix)) {
    return base;
  }

  const prefix = endpoint.slice(0, endpoint.length - suffix.length);
  if (!prefix || prefix === "/") {
    return base;
  }
  return `${base}${prefix}`;
}

export interface ResolvedLLMRuntime {
  provider: "deepseek";
  baseURL: string;
  requestURL: string;
  model: string;
  modelSettings: ModelSettings;
}

export function resolveLLMRuntime(
  env: AppEnv,
  runtimeProfile?: ModelProfile,
  modelSettingsOverride?: Partial<ModelSettings>
): ResolvedLLMRuntime {
  const baseModelSettings: ModelSettings = { temperature: env.deepseekTemperature };

  let modelSettings: ModelSettings = baseModelSettings;
  if (modelSettingsOverride) {
    modelSettings = {
      ...baseModelSettings,
      ...modelSettingsOverride
    };
    if (baseModelSettings.providerData || modelSettingsOverride.providerData) {
      modelSettings.providerData = {
        ...(baseModelSettings.providerData ?? {}),
        ...(modelSettingsOverride.providerData ?? {})
      };
    }
  }

  return {
    provider: "deepseek",
    baseURL: resolveProviderBaseURL(env.deepseekBaseUrl, env.deepseekChatPath, "/chat/completions"),
    requestURL: joinUrl(env.deepseekBaseUrl, env.deepseekChatPath),
    model: runtimeProfile?.model ?? env.deepseekModel,
    modelSettings
  };
}
