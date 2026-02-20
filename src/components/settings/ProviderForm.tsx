"use client";

import { useState, useEffect, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import type { ApiProvider } from "@/types";

const PROVIDER_PRESETS: Record<string, { base_url: string; extra_env: string }> = {
  anthropic: { base_url: "https://api.anthropic.com", extra_env: "{}" },
  openrouter: { base_url: "https://openrouter.ai/api", extra_env: '{"ANTHROPIC_API_KEY":""}' },
  bedrock: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}' },
  vertex: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}' },
  foundry: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_FOUNDRY":"1","ANTHROPIC_FOUNDRY_RESOURCE":"your-resource","CLAUDE_CODE_SKIP_FOUNDRY_AUTH":"1"}' },
  custom: { base_url: "", extra_env: "{}" },
};

const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex" },
  { value: "foundry", label: "Microsoft Foundry" },
  { value: "custom", label: "Custom" },
];

interface ProviderFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  provider?: ApiProvider | null;
  onSave: (data: ProviderFormData) => Promise<void>;
  initialPreset?: { name: string; provider_type: string; base_url: string; extra_env?: string } | null;
}

export interface ProviderFormData {
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  extra_env: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// FieldHelp — click-triggered popover with a "?" icon
// ---------------------------------------------------------------------------

function FieldHelp({ children }: { children: ReactNode }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          tabIndex={-1}
        >
          <HugeiconsIcon icon={HelpCircleIcon} className="h-3 w-3" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={4}
          className="z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <div className="space-y-1.5 text-xs leading-relaxed">
            {children}
          </div>
          <PopoverPrimitive.Arrow className="fill-border" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function HelpCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
      {children}
    </code>
  );
}

function HelpLink({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block text-primary hover:underline mt-1.5"
    >
      {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Help content per field
// ---------------------------------------------------------------------------

function getUrlHelp(providerType: string): ReactNode {
  switch (providerType) {
    case "anthropic":
      return <p>Direct Anthropic API endpoint. Usually no change needed.</p>;
    case "openrouter":
      return (
        <>
          <p>OpenRouter proxy gateway. Routes requests to your chosen model provider.</p>
          <HelpLink url="https://openrouter.ai/docs" label="OpenRouter docs &#8594;" />
        </>
      );
    case "bedrock":
      return <p>Leave empty. Bedrock uses region-based endpoints configured via <HelpCode>AWS_REGION</HelpCode> in Extra Env.</p>;
    case "vertex":
      return <p>Leave empty. Vertex AI uses region-based endpoints configured via <HelpCode>CLOUD_ML_REGION</HelpCode> in Extra Env.</p>;
    case "foundry":
      return <p>Leave empty. Foundry uses the resource name from <HelpCode>ANTHROPIC_FOUNDRY_RESOURCE</HelpCode> in Extra Env.</p>;
    default:
      return <p>Your provider&apos;s Anthropic Messages API compatible endpoint URL.</p>;
  }
}

function getKeyHelp(providerType: string, presetHint: string): ReactNode {
  // For custom providers, check preset-specific help first
  if (providerType === "custom" && presetHint) {
    switch (presetHint) {
      case "DeepSeek":
        return (
          <>
            <p>Your DeepSeek API key.</p>
            <HelpLink url="https://platform.deepseek.com/api_keys" label="Get API key &#8594;" />
          </>
        );
      case "GLM (CN)":
        return (
          <>
            <p>Your ZhipuAI (GLM) API key for China endpoint.</p>
            <HelpLink url="https://bigmodel.cn/usercenter/apikeys" label="Get API key &#8594;" />
          </>
        );
      case "GLM (Global)":
        return (
          <>
            <p>Your GLM Global API key.</p>
            <HelpLink url="https://z.ai" label="Get API key &#8594;" />
          </>
        );
      case "Qwen (Global)":
        return (
          <>
            <p>Your DashScope (Alibaba Cloud) API key.</p>
            <HelpLink url="https://dashscope.console.aliyun.com/" label="Get API key &#8594;" />
          </>
        );
      case "Kimi Coding Plan":
        return (
          <>
            <p>Your Kimi Coding Plan auth token. Entered as <HelpCode>ANTHROPIC_AUTH_TOKEN</HelpCode>.</p>
            <HelpLink url="https://platform.moonshot.cn/" label="Get token &#8594;" />
          </>
        );
      case "Moonshot":
        return (
          <>
            <p>Your Moonshot AI API key.</p>
            <HelpLink url="https://platform.moonshot.cn/console/api-keys" label="Get API key &#8594;" />
          </>
        );
      case "MiniMax (CN)":
        return (
          <>
            <p>Your MiniMax API key for China endpoint.</p>
            <HelpLink url="https://platform.minimaxi.chat/" label="Get API key &#8594;" />
          </>
        );
      case "MiniMax (Global)":
        return (
          <>
            <p>Your MiniMax API key for Global endpoint.</p>
            <HelpLink url="https://platform.minimax.io/" label="Get API key &#8594;" />
          </>
        );
      case "Ollama":
        return (
          <>
            <p>Enter any value (e.g. <HelpCode>ollama</HelpCode>). Ollama runs locally and doesn&apos;t require authentication.</p>
            <p className="text-muted-foreground">Requires Ollama v0.14.0+</p>
            <HelpLink url="https://ollama.com/blog/claude" label="Setup guide &#8594;" />
          </>
        );
      case "LM Studio":
        return (
          <>
            <p>Enter any value (e.g. <HelpCode>lmstudio</HelpCode>). LM Studio runs locally and doesn&apos;t require authentication.</p>
            <p className="text-muted-foreground">Requires LM Studio v0.4.1+</p>
            <HelpLink url="https://lmstudio.ai/blog/claudecode" label="Setup guide &#8594;" />
          </>
        );
      case "LiteLLM":
        return <p>The API key configured in your LiteLLM proxy, or any value if auth is disabled.</p>;
    }
  }

  switch (providerType) {
    case "anthropic":
      return (
        <>
          <p>Your Anthropic API key.</p>
          <p className="text-muted-foreground">Format: <HelpCode>sk-ant-api03-...</HelpCode></p>
          <HelpLink url="https://console.anthropic.com/settings/keys" label="Get API key &#8594;" />
        </>
      );
    case "openrouter":
      return (
        <>
          <p>Your OpenRouter API key (not your Anthropic key).</p>
          <p className="text-muted-foreground">Format: <HelpCode>sk-or-v1-...</HelpCode></p>
          <HelpLink url="https://openrouter.ai/keys" label="Get API key &#8594;" />
        </>
      );
    case "bedrock":
      return (
        <>
          <p>For API gateway auth, enter the gateway API key here.</p>
          <p className="text-muted-foreground">For direct AWS auth, leave empty and configure <HelpCode>AWS_ACCESS_KEY_ID</HelpCode> + <HelpCode>AWS_SECRET_ACCESS_KEY</HelpCode> in Extra Env.</p>
        </>
      );
    case "vertex":
      return (
        <>
          <p>For API gateway auth, enter the gateway API key here.</p>
          <p className="text-muted-foreground">For direct GCP auth, leave empty and configure Google Cloud credentials separately.</p>
        </>
      );
    case "foundry":
      return (
        <>
          <p>For API gateway auth, enter the gateway API key here.</p>
          <p className="text-muted-foreground">For direct key auth, set <HelpCode>ANTHROPIC_FOUNDRY_API_KEY</HelpCode> in Extra Env instead.</p>
        </>
      );
    default:
      return <p>API key or auth token from your provider. This value is stored encrypted.</p>;
  }
}

function getEnvHelp(providerType: string): ReactNode {
  switch (providerType) {
    case "anthropic":
      return <p>Additional environment variables passed to the Claude Code subprocess. Usually not needed for direct Anthropic API.</p>;
    case "openrouter":
      return (
        <>
          <p><HelpCode>ANTHROPIC_API_KEY</HelpCode> is cleared to avoid conflicts with the OpenRouter key.</p>
          <p className="text-muted-foreground">Add it here with your Anthropic key value if you need hybrid routing.</p>
        </>
      );
    case "bedrock":
      return (
        <>
          <p><HelpCode>AWS_REGION</HelpCode> &mdash; AWS region (e.g. us-east-1).</p>
          <p className="text-muted-foreground">For direct auth, add <HelpCode>AWS_ACCESS_KEY_ID</HelpCode> and <HelpCode>AWS_SECRET_ACCESS_KEY</HelpCode>. The <HelpCode>CLAUDE_CODE_SKIP_BEDROCK_AUTH</HelpCode> flag is for gateway auth.</p>
        </>
      );
    case "vertex":
      return (
        <>
          <p><HelpCode>CLOUD_ML_REGION</HelpCode> &mdash; GCP region (e.g. us-east5).</p>
          <p className="text-muted-foreground">Optionally set <HelpCode>ANTHROPIC_VERTEX_PROJECT_ID</HelpCode>. The <HelpCode>CLAUDE_CODE_SKIP_VERTEX_AUTH</HelpCode> flag is for gateway auth.</p>
        </>
      );
    case "foundry":
      return (
        <>
          <p><HelpCode>ANTHROPIC_FOUNDRY_RESOURCE</HelpCode> &mdash; your Azure resource name (required).</p>
          <p className="text-muted-foreground">For direct key auth, add <HelpCode>ANTHROPIC_FOUNDRY_API_KEY</HelpCode>. The <HelpCode>CLAUDE_CODE_SKIP_FOUNDRY_AUTH</HelpCode> flag is for gateway auth.</p>
        </>
      );
    default:
      return (
        <>
          <p>JSON key-value pairs passed as env vars to Claude Code.</p>
          <p className="text-muted-foreground">Set a value to <HelpCode>&quot;&quot;</HelpCode> (empty string) to explicitly clear that variable.</p>
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// ProviderForm
// ---------------------------------------------------------------------------

export function ProviderForm({
  open,
  onOpenChange,
  mode,
  provider,
  onSave,
  initialPreset,
}: ProviderFormProps) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extraEnv, setExtraEnv] = useState("{}");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presetHint, setPresetHint] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);

    if (mode === "edit" && provider) {
      setName(provider.name);
      setProviderType(provider.provider_type);
      setBaseUrl(provider.base_url);
      setApiKey("");
      setExtraEnv(provider.extra_env || "{}");
      setNotes(provider.notes || "");
      setPresetHint("");
      // Show advanced if extra_env has content
      try {
        const parsed = JSON.parse(provider.extra_env || "{}");
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(true);
      }
    } else if (initialPreset) {
      setName(initialPreset.name);
      setProviderType(initialPreset.provider_type);
      setBaseUrl(initialPreset.base_url);
      setApiKey("");
      // Use extra_env from preset if provided, otherwise look up by type
      const envStr = initialPreset.extra_env || PROVIDER_PRESETS[initialPreset.provider_type]?.extra_env || "{}";
      setExtraEnv(envStr);
      setNotes("");
      setPresetHint(initialPreset.name);
      try {
        const parsed = JSON.parse(envStr);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    } else {
      setName("");
      setProviderType("anthropic");
      setBaseUrl(PROVIDER_PRESETS.anthropic.base_url);
      setApiKey("");
      setExtraEnv("{}");
      setNotes("");
      setShowAdvanced(false);
      setPresetHint("");
    }
  }, [open, mode, provider, initialPreset]);

  const handleTypeChange = (type: string) => {
    setProviderType(type);
    setPresetHint(""); // Clear preset hint when type changes manually
    const preset = PROVIDER_PRESETS[type];
    if (preset) {
      setBaseUrl(preset.base_url);
      setExtraEnv(preset.extra_env);
      try {
        const parsed = JSON.parse(preset.extra_env);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    // Validate extra_env JSON
    try {
      JSON.parse(extraEnv);
    } catch {
      setError("Extra environment variables must be valid JSON");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        provider_type: providerType,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        extra_env: extraEnv,
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const isMaskedKey = mode === "edit" && provider?.api_key?.startsWith("***");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit Provider" : "Add Provider"}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Update the API provider configuration."
              : "Configure a new API provider for Claude Code."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="provider-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="provider-name"
              placeholder="My API Provider"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-type" className="text-xs text-muted-foreground">
              Provider Type
            </Label>
            <Select value={providerType} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="provider-base-url" className="text-xs text-muted-foreground">
                API Base URL
              </Label>
              <FieldHelp>{getUrlHelp(providerType)}</FieldHelp>
            </div>
            <Input
              id="provider-base-url"
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="provider-api-key" className="text-xs text-muted-foreground">
                API Key
              </Label>
              <FieldHelp>{getKeyHelp(providerType, presetHint)}</FieldHelp>
            </div>
            <Input
              id="provider-api-key"
              type="password"
              placeholder={isMaskedKey ? "Leave empty to keep current key" : "sk-ant-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          {/* Advanced options toggle */}
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <HugeiconsIcon
              icon={showAdvanced ? ArrowUp01Icon : ArrowDown01Icon}
              className="h-3 w-3"
            />
            Advanced Options
          </button>

          {showAdvanced && (
            <div className="space-y-4 border-t border-border/50 pt-4">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="provider-extra-env" className="text-xs text-muted-foreground">
                    Extra Environment Variables (JSON)
                  </Label>
                  <FieldHelp>{getEnvHelp(providerType)}</FieldHelp>
                </div>
                <Textarea
                  id="provider-extra-env"
                  placeholder='{"KEY": "value"}'
                  value={extraEnv}
                  onChange={(e) => setExtraEnv(e.target.value)}
                  className="font-mono text-sm min-h-[80px]"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-notes" className="text-xs text-muted-foreground">
                  Notes
                </Label>
                <Textarea
                  id="provider-notes"
                  placeholder="Optional notes about this provider..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="text-sm"
                  rows={2}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && (
                <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              )}
              {saving ? "Saving..." : mode === "edit" ? "Update" : "Add Provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
