"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, Tick01Icon } from "@hugeicons/core-free-icons";

const STT_PROVIDERS = [
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "openai", label: "OpenAI" },
  { value: "groq", label: "Groq" },
];

export function SttSection() {
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [deployment, setDeployment] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (!res.ok) return;
      const data = await res.json();
      const s = data.settings || {};
      setProvider(s.stt_provider || "");
      setApiKey(s.stt_api_key || "");
      setEndpoint(s.stt_endpoint || "");
      setModel(s.stt_model || "");
      setDeployment(s.stt_deployment || "");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            stt_provider: provider,
            stt_api_key: apiKey,
            stt_endpoint: endpoint,
            stt_model: model,
            stt_deployment: deployment,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const showEndpoint = provider === "azure_openai" || endpoint;
  const showDeployment = provider === "azure_openai";
  const showModel = provider === "openai" || provider === "groq";

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">Speech to Text</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure a Whisper-compatible API for voice input. Requires HTTPS for microphone access.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-full text-sm">
              <SelectValue placeholder="Select provider..." />
            </SelectTrigger>
            <SelectContent>
              {STT_PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {provider && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">API Key</Label>
              <Input
                type="password"
                placeholder={apiKey.startsWith("***") ? "Leave empty to keep current key" : "Enter API key..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            {showEndpoint && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {provider === "azure_openai" ? "Azure Endpoint" : "Custom Endpoint (optional)"}
                </Label>
                <Input
                  placeholder={
                    provider === "azure_openai"
                      ? "https://your-resource.openai.azure.com"
                      : "https://api.openai.com"
                  }
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            )}

            {showDeployment && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Deployment Name</Label>
                <Input
                  placeholder="whisper"
                  value={deployment}
                  onChange={(e) => setDeployment(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            )}

            {showModel && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Model</Label>
                <Input
                  placeholder={provider === "groq" ? "whisper-large-v3" : "whisper-1"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !provider}>
          {saving ? (
            <>
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : saved ? (
            <>
              <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5" />
              Saved
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}
