export interface ModelOption {
  value: string;
  label: string;
  group: 'claude' | 'codex';
}

export interface EffortOption {
  value: string;
  label: string;
}

export interface CodexModelInfo {
  value: string;
  label: string;
  reasoningEfforts?: EffortOption[];
  defaultEffort?: string;
}

export interface ClaudeModelEffortInfo {
  supportsEffort: boolean;
  supportedEffortLevels: string[];
}

export interface ModelCatalog {
  models: ModelOption[];
  claudeEffortInfo: Map<string, ClaudeModelEffortInfo>;
  codexModelInfo: Map<string, CodexModelInfo>;
}

interface ClaudeModelsResponse {
  models?: Array<{
    value: string;
    displayName: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
  }>;
}

interface CodexModelsResponse {
  models?: Array<{
    value: string;
    displayName: string;
    reasoningEfforts?: EffortOption[];
    defaultEffort?: string;
  }>;
}

export async function fetchModelCatalog(refresh = false): Promise<ModelCatalog> {
  const modelsUrl = refresh ? '/api/models?refresh=true' : '/api/models';
  const [claudeData, codexData]: [ClaudeModelsResponse, CodexModelsResponse] = await Promise.all([
    fetch(modelsUrl).then((response) => (response.ok ? response.json() : { models: [] })).catch(() => ({ models: [] })),
    fetch('/api/codex/models').then((response) => (response.ok ? response.json() : { models: [] })).catch(() => ({ models: [] })),
  ]);

  const claudeModels: ModelOption[] = (claudeData.models || []).map((model) => ({
    value: model.value,
    label: model.displayName,
    group: 'claude',
  }));
  const codexModels: ModelOption[] = (codexData.models || []).map((model) => ({
    value: model.value,
    label: model.displayName,
    group: 'codex',
  }));

  const claudeEffortInfo = new Map<string, ClaudeModelEffortInfo>();
  for (const model of claudeData.models || []) {
    if (model.supportsEffort && model.supportedEffortLevels?.length) {
      claudeEffortInfo.set(model.value, {
        supportsEffort: true,
        supportedEffortLevels: model.supportedEffortLevels,
      });
    }
  }

  const codexModelInfo = new Map<string, CodexModelInfo>();
  for (const model of codexData.models || []) {
    codexModelInfo.set(model.value, {
      value: model.value,
      label: model.displayName,
      reasoningEfforts: model.reasoningEfforts,
      defaultEffort: model.defaultEffort,
    });
  }

  return {
    models: [...claudeModels, ...codexModels],
    claudeEffortInfo,
    codexModelInfo,
  };
}

export function inferBackendFromModel(
  model: string,
  codexModelInfo: Map<string, CodexModelInfo>,
): 'claude' | 'codex' {
  return codexModelInfo.has(model) ? 'codex' : 'claude';
}

export function getPreferredDefaultModel(models: ModelOption[]): string | undefined {
  const preferred =
    models.find((model) => model.value === 'sonnet') ??
    models.find((model) => model.value === 'default') ??
    models.find((model) => model.value !== 'default') ??
    models[0];

  return preferred?.value;
}

export function getEffortOptionsForModel(
  model: string,
  claudeEffortInfo: Map<string, ClaudeModelEffortInfo>,
  codexModelInfo: Map<string, CodexModelInfo>,
): EffortOption[] {
  const codexInfo = codexModelInfo.get(model);
  if (codexInfo?.reasoningEfforts?.length) {
    return codexInfo.reasoningEfforts;
  }

  const claudeInfo = claudeEffortInfo.get(model);
  if (claudeInfo?.supportsEffort && claudeInfo.supportedEffortLevels.length > 0) {
    return claudeInfo.supportedEffortLevels.map((level) => ({
      value: level,
      label: level.charAt(0).toUpperCase() + level.slice(1),
    }));
  }

  return [];
}

export function getDefaultEffortForModel(
  model: string,
  claudeEffortInfo: Map<string, ClaudeModelEffortInfo>,
  codexModelInfo: Map<string, CodexModelInfo>,
): string | undefined {
  const codexInfo = codexModelInfo.get(model);
  if (codexInfo?.defaultEffort) return codexInfo.defaultEffort;

  const claudeInfo = claudeEffortInfo.get(model);
  if (claudeInfo?.supportsEffort) return 'high';

  return undefined;
}

export function normalizeEffortForModel(
  model: string,
  effort: string | undefined,
  claudeEffortInfo: Map<string, ClaudeModelEffortInfo>,
  codexModelInfo: Map<string, CodexModelInfo>,
): string {
  const options = getEffortOptionsForModel(model, claudeEffortInfo, codexModelInfo);
  if (options.length === 0) return '';

  const values = options.map((option) => option.value);
  const fallback = getDefaultEffortForModel(model, claudeEffortInfo, codexModelInfo) || values[0] || '';

  if (!effort) return fallback;
  if (!values.includes(effort)) return fallback;
  return effort;
}
