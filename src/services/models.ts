import { getContextLength } from './telemetry.ts';

export interface DeepsProxyModel {
  id: string;
  root: string;
  owned_by: string;
  aliases: string[];
  thinking: boolean;
  pro: boolean;
  vision: boolean;
}

export interface ResolvedModel extends DeepsProxyModel {
  requested: string;
}

const MODEL_CREATED_AT = 1_715_616_000;

export const deepsProxyModels: DeepsProxyModel[] = [
  {
    id: 'deepseek-v4-flash',
    root: 'deepseek-v4-flash',
    owned_by: 'deepseek',
    aliases: ['deepseek-flash', 'deepseek-chat'],
    thinking: false,
    pro: false,
    vision: false,
  },
  {
    id: 'deepseek-v4-flash-thinking',
    root: 'deepseek-v4-flash-thinking',
    owned_by: 'deepseek',
    aliases: ['deepseek-flash-thinking', 'deepseek-thinking', 'deepseek-reasoner'],
    thinking: true,
    pro: false,
    vision: false,
  },
  {
    id: 'deepseek-v4-pro',
    root: 'deepseek-v4-pro',
    owned_by: 'deepseek',
    aliases: ['deepseek-pro'],
    thinking: false,
    pro: true,
    vision: false,
  },
  {
    id: 'deepseek-v4-pro-thinking',
    root: 'deepseek-v4-pro-thinking',
    owned_by: 'deepseek',
    aliases: ['deepseek-pro-thinking'],
    thinking: true,
    pro: true,
    vision: false,
  },
];

const modelLookup = new Map<string, DeepsProxyModel>();
for (const model of deepsProxyModels) {
  modelLookup.set(model.id, model);
  for (const alias of model.aliases) {
    modelLookup.set(alias, model);
  }
}

export function listAcceptedModelIds(): string[] {
  return deepsProxyModels.flatMap((model) => [model.id, ...model.aliases]);
}

export function resolveModel(modelId: string): ResolvedModel | null {
  const model = modelLookup.get(modelId);
  if (!model) return null;
  return { ...model, requested: modelId };
}

export function modelNotFoundError(modelId: string) {
  return {
    error: {
      message: `The model '${modelId}' does not exist or is not available through DeepsProxy.`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  };
}

export function modelEntry(modelId: string) {
  const resolved = resolveModel(modelId);
  if (!resolved) return null;

  const dynamicLimit = getContextLength(resolved.root);
  return {
    id: modelId,
    object: 'model',
    created: MODEL_CREATED_AT,
    owned_by: resolved.owned_by,
    permission: [],
    root: resolved.root,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    max_output_tokens: 8_000,
    capabilities: {
      reasoning: resolved.thinking,
      tools: true,
      parallel_tool_calls: true,
      prompt_cache_key: true,
      images: resolved.vision,
    },
  };
}
