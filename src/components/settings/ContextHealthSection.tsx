"use client";

import { useState, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { rules } from "@/lib/context-health";
import type { RuleConfig, RuleOverride } from "@/lib/context-health";

/** Severity badge colors */
const severityColors: Record<string, string> = {
  critical: "bg-red-500/15 text-red-600 dark:text-red-400",
  warning: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
};

/** Unit suffix for display */
const unitLabel: Record<string, string> = {
  percentage: "%",
  multiplier: "×",
  minutes: " min",
};

export function ContextHealthSection() {
  const [config, setConfig] = useState<RuleConfig>({});
  const [masterEnabled, setMasterEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load config on mount
  useEffect(() => {
    fetch("/api/settings/app")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.settings) {
          setMasterEnabled(data.settings.context_health_enabled !== "false");
          if (data.settings.context_health_config) {
            try {
              setConfig(JSON.parse(data.settings.context_health_config));
            } catch {
              /* ignore */
            }
          }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const saveConfig = useCallback(
    async (newConfig: RuleConfig, enabled?: boolean) => {
      setSaving(true);
      try {
        const settings: Record<string, string> = {
          context_health_config: JSON.stringify(newConfig),
        };
        if (enabled !== undefined) {
          settings.context_health_enabled = String(enabled);
        }
        await fetch("/api/settings/app", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        });
      } catch {
        /* ignore */
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const toggleMaster = useCallback(
    (checked: boolean) => {
      setMasterEnabled(checked);
      saveConfig(config, checked);
    },
    [config, saveConfig]
  );

  const toggleRule = useCallback(
    (ruleId: string, enabled: boolean) => {
      const newConfig = {
        ...config,
        [ruleId]: { ...config[ruleId], enabled },
      };
      setConfig(newConfig);
      saveConfig(newConfig);
    },
    [config, saveConfig]
  );

  const updateThreshold = useCallback(
    (ruleId: string, value: number) => {
      const newConfig = {
        ...config,
        [ruleId]: { ...config[ruleId], threshold: value },
      };
      setConfig(newConfig);
      // Debounce save — only save when input loses focus (onBlur triggers this)
    },
    [config]
  );

  const saveThreshold = useCallback(() => {
    // Save current config state (called onBlur)
    saveConfig(config);
  }, [config, saveConfig]);

  const getRuleOverride = (ruleId: string): RuleOverride => config[ruleId] ?? {};

  if (!loaded) {
    return (
      <div className="text-sm text-muted-foreground">Loading...</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">Context Health Monitor</h3>
          <p className="text-sm text-muted-foreground">
            Detect context bloat, cache misses, and cost spikes. Claude backend
            only.
          </p>
        </div>
        <Switch checked={masterEnabled} onCheckedChange={toggleMaster} />
      </div>

      {!masterEnabled && (
        <p className="text-sm text-muted-foreground italic">
          All context health alerts are disabled.
        </p>
      )}

      {/* Rules list */}
      {masterEnabled && (
        <div className="space-y-4">
          {rules.map((rule) => {
            const override = getRuleOverride(rule.id);
            const isEnabled = override.enabled !== false;
            const schema = rule.configSchema;
            const currentThreshold =
              override.threshold ?? schema?.default ?? 0;

            return (
              <div
                key={rule.id}
                className={`rounded-lg border p-4 transition-opacity ${
                  isEnabled ? "" : "opacity-50"
                }`}
              >
                {/* Rule header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                        severityColors[rule.severity]
                      }`}
                    >
                      {rule.severity}
                    </span>
                    <span className="min-w-0 break-words text-sm font-medium">
                      {rule.name}
                    </span>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {rule.description}
                    </p>
                  </div>
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => toggleRule(rule.id, checked)}
                    className="shrink-0"
                  />
                </div>

                {/* Threshold control */}
                {schema && isEnabled && (
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label className="text-xs font-medium text-muted-foreground">
                        {schema.label}:
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          value={currentThreshold}
                          min={schema.min}
                          max={schema.max}
                          step={schema.step ?? 1}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) updateThreshold(rule.id, v);
                          }}
                          onBlur={saveThreshold}
                          className="h-7 w-20 text-xs"
                          disabled={saving}
                        />
                        <span className="text-xs text-muted-foreground">
                          {unitLabel[schema.type] ?? ""}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground/60 sm:ml-auto">
                        default: {schema.default}
                        {unitLabel[schema.type] ?? ""}
                      </span>
                    </div>
                    {/* Tip */}
                    <p className="max-w-full text-[11px] leading-relaxed text-muted-foreground/70 break-words">
                      💡 {schema.tip}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer note */}
      {masterEnabled && (
        <p className="text-xs text-muted-foreground/60">
          Thresholds are based on official Anthropic documentation (April 2026).
          Changes take effect on the next message — no restart needed.
        </p>
      )}
    </div>
  );
}
