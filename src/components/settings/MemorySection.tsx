"use client";

import { useState, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PinIcon, Add01Icon, Edit02Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { MemoryItem } from "@/types";

type FilterScope = "all" | "user" | "project";
type FilterType = "all" | "memory" | "skill";

export function MemorySection() {
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterScope, setFilterScope] = useState<FilterScope>("all");
  const [filterType, setFilterType] = useState<FilterType>("all");

  // New memory form
  const [showForm, setShowForm] = useState(false);
  const [formScope, setFormScope] = useState<"user" | "project">("user");
  const [formType, setFormType] = useState<"memory" | "skill">("memory");
  const [formContent, setFormContent] = useState("");
  const [formScopeKey, setFormScopeKey] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // Fetch global setting
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        setGlobalEnabled(data.settings?.memory_enabled === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch memories
  const fetchMemories = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterScope !== "all") params.set("scope", filterScope);
      if (filterType !== "all") params.set("type", filterType);
      const res = await fetch(`/api/memory?${params}`);
      if (res.ok) {
        const data = await res.json();
        setMemories(data.memories || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [filterScope, filterType]);

  useEffect(() => {
    fetchSettings();
    fetchMemories();
  }, [fetchSettings, fetchMemories]);

  const handleGlobalToggle = async (checked: boolean) => {
    setGlobalEnabled(checked);
    try {
      await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { memory_enabled: checked ? "true" : "" },
        }),
      });
    } catch {
      setGlobalEnabled(!checked);
    }
  };

  const handleCreate = async () => {
    if (!formContent.trim()) return;
    if (formScope === "project" && !formScopeKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: formScope,
          type: formType,
          content: formContent.trim(),
          scope_key: formScope === "project" ? formScopeKey.trim() : undefined,
          description: formDescription.trim() || undefined,
        }),
      });
      if (res.ok) {
        setFormContent("");
        setFormDescription("");
        setFormScopeKey("");
        setShowForm(false);
        fetchMemories();
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this memory?")) return;
    try {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      }
    } catch {
      // ignore
    }
  };

  const handleTogglePin = async (id: string, currentPinned: number) => {
    const newPinned = !currentPinned;
    // Optimistic update
    setMemories((prev) =>
      prev.map((m) => (m.id === id ? { ...m, pinned: newPinned ? 1 : 0 } : m))
    );
    try {
      await fetch(`/api/memory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: newPinned }),
      });
    } catch {
      setMemories((prev) =>
        prev.map((m) => (m.id === id ? { ...m, pinned: currentPinned } : m))
      );
    }
  };

  const handleStartEdit = (memory: MemoryItem) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
  };

  const handleSaveEdit = async (id: string) => {
    if (!editContent.trim()) return;
    try {
      const res = await fetch(`/api/memory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent.trim() }),
      });
      if (res.ok) {
        setMemories((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: editContent.trim() } : m))
        );
        setEditingId(null);
      }
    } catch {
      // ignore
    }
  };

  const userCount = memories.filter((m) => m.scope === "user").length;
  const projectCount = memories.filter((m) => m.scope === "project").length;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Global toggle */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Memory System</h2>
            <p className="text-xs text-muted-foreground">
              Inject remembered context into new conversations. Each session
              can override this default.
            </p>
          </div>
          <Switch checked={globalEnabled} onCheckedChange={handleGlobalToggle} />
        </div>
        {globalEnabled && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            Memory context will be injected at the start of new conversations.
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="flex gap-3">
        <div className="rounded-lg border border-border/50 px-4 py-3 flex-1">
          <div className="text-2xl font-semibold">{memories.length}</div>
          <div className="text-xs text-muted-foreground">Total memories</div>
        </div>
        <div className="rounded-lg border border-border/50 px-4 py-3 flex-1">
          <div className="text-2xl font-semibold">{userCount}</div>
          <div className="text-xs text-muted-foreground">User-level</div>
        </div>
        <div className="rounded-lg border border-border/50 px-4 py-3 flex-1">
          <div className="text-2xl font-semibold">{projectCount}</div>
          <div className="text-xs text-muted-foreground">Project-level</div>
        </div>
      </div>

      {/* Filters + Add button */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1">
          {(["all", "user", "project"] as FilterScope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterScope(s)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                filterScope === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "All Scopes" : s === "user" ? "User" : "Project"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["all", "memory", "skill"] as FilterType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilterType(t)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                filterType === t
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "all" ? "All Types" : t === "memory" ? "Memories" : "Skills"}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={() => setShowForm(!showForm)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={showForm ? Cancel01Icon : Add01Icon} className="h-3.5 w-3.5" />
            {showForm ? "Cancel" : "Add Memory"}
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-lg border border-border/50 p-4 space-y-3">
          <div className="flex gap-3">
            <div className="space-y-1 flex-1">
              <label className="text-xs font-medium text-muted-foreground">Scope</label>
              <select
                value={formScope}
                onChange={(e) => setFormScope(e.target.value as "user" | "project")}
                className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="user">User (global)</option>
                <option value="project">Project</option>
              </select>
            </div>
            <div className="space-y-1 flex-1">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as "memory" | "skill")}
                className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="memory">Memory (fact)</option>
                <option value="skill">Skill (procedure)</option>
              </select>
            </div>
          </div>
          {formScope === "project" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Project Path
              </label>
              <Input
                value={formScopeKey}
                onChange={(e) => setFormScopeKey(e.target.value)}
                placeholder="/Users/you/working/my-project"
                className="font-mono text-sm"
              />
            </div>
          )}
          {formType === "skill" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Description (shown in index)
              </label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Brief description of what this skill does"
                className="text-sm"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Content
            </label>
            <Textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder={
                formType === "memory"
                  ? "This project uses Next.js standalone mode with better-sqlite3..."
                  : "## Deploy to production\n1. Run rebuild-production.sh\n2. Check logs..."
              }
              rows={formType === "skill" ? 6 : 3}
              className="text-sm"
            />
          </div>
          <Button onClick={handleCreate} disabled={saving || !formContent.trim()} size="sm">
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}

      {/* Memory list */}
      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-8">Loading...</div>
      ) : memories.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">
          No memories yet. Add your first memory or use the &quot;Remember&quot;
          button on chat messages.
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <div
              key={memory.id}
              className={`rounded-lg border p-3 transition-shadow hover:shadow-sm ${
                memory.pinned ? "border-blue-500/30 bg-blue-500/5" : "border-border/50"
              }`}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {memory.scope}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {memory.type}
                    </Badge>
                    {memory.scope === "project" && memory.scope_key && (
                      <span className="text-[10px] text-muted-foreground font-mono truncate">
                        {memory.scope_key.split("/").pop()}
                      </span>
                    )}
                    {memory.pinned === 1 && (
                      <HugeiconsIcon icon={PinIcon} className="h-3 w-3 text-blue-500" />
                    )}
                  </div>

                  {editingId === memory.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={3}
                        className="text-sm"
                      />
                      <div className="flex gap-1.5">
                        <Button size="sm" onClick={() => handleSaveEdit(memory.id)} className="h-7 gap-1">
                          <HugeiconsIcon icon={Tick02Icon} className="h-3 w-3" /> Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="h-7">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {memory.content}
                    </p>
                  )}

                  {memory.description && editingId !== memory.id && (
                    <p className="text-xs text-muted-foreground mt-1 italic">
                      {memory.description}
                    </p>
                  )}
                  <div className="text-[10px] text-muted-foreground/50 mt-1">
                    {new Date(memory.created_at).toLocaleDateString()}
                    {memory.updated_at !== memory.created_at && (
                      <> · updated {new Date(memory.updated_at).toLocaleDateString()}</>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {editingId !== memory.id && (
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleTogglePin(memory.id, memory.pinned)}
                      className={`p-1 rounded transition-colors ${
                        memory.pinned
                          ? "text-blue-500 hover:text-blue-600"
                          : "text-muted-foreground/40 hover:text-muted-foreground"
                      }`}
                      title={memory.pinned ? "Unpin" : "Pin (always included)"}
                    >
                      <HugeiconsIcon icon={PinIcon} className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStartEdit(memory)}
                      className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                      title="Edit"
                    >
                      <HugeiconsIcon icon={Edit02Icon} className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(memory.id)}
                      className="p-1 rounded text-muted-foreground/40 hover:text-red-500 transition-colors"
                      title="Delete"
                    >
                      <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
