"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, Search01Icon, ZapIcon, Loading02Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { SkillListItem } from "./SkillListItem";
import { SkillEditor } from "./SkillEditor";
import { CreateSkillDialog } from "./CreateSkillDialog";
import type { SkillItem } from "./SkillListItem";
import { usePanel } from "@/hooks/usePanel";

export function SkillsManager() {
  const { workingDirectory } = usePanel();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const fetchSkills = useCallback(async () => {
    try {
      const params = workingDirectory ? `?cwd=${encodeURIComponent(workingDirectory)}` : "";
      const res = await fetch(`/api/skills${params}`);
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleCreate = useCallback(
    async (name: string, scope: "global" | "project", content: string) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, scope, cwd: workingDirectory || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create skill");
      }
      const data = await res.json();
      setSkills((prev) => [...prev, data.skill]);
      setSelected(data.skill);
    },
    [workingDirectory]
  );

  const buildSkillUrl = useCallback((skill: SkillItem) => {
    const base = `/api/skills/${encodeURIComponent(skill.name)}`;
    const params = new URLSearchParams();
    if (skill.source === "installed" && skill.installedSource) {
      params.set("source", skill.installedSource);
    }
    if (workingDirectory) {
      params.set("cwd", workingDirectory);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }, [workingDirectory]);

  const handleSave = useCallback(
    async (skill: SkillItem, content: string) => {
      const res = await fetch(buildSkillUrl(skill), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save skill");
      }
      const data = await res.json();
      // Update in list
      setSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name &&
          s.source === data.skill.source &&
          s.installedSource === data.skill.installedSource
            ? data.skill
            : s
        )
      );
      // Update selected
      setSelected(data.skill);
    },
    [buildSkillUrl]
  );

  const handleDelete = useCallback(
    async (skill: SkillItem) => {
      const res = await fetch(buildSkillUrl(skill), { method: "DELETE" });
      if (res.ok) {
        setSkills((prev) =>
          prev.filter(
            (s) =>
              !(
                s.name === skill.name &&
                s.source === skill.source &&
                s.installedSource === skill.installedSource
              )
          )
        );
        if (
          selected?.name === skill.name &&
          selected?.source === skill.source &&
          selected?.installedSource === skill.installedSource
        ) {
          setSelected(null);
        }
      }
    },
    [buildSkillUrl, selected]
  );

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase())
  );

  const globalSkills = filtered.filter((s) => s.source === "global");
  const projectSkills = filtered.filter((s) => s.source === "project");
  const installedSkills = filtered.filter((s) => s.source === "installed");
  const pluginSkills = filtered.filter((s) => s.source === "plugin");

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          Loading skills...
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold flex-1">Skills</h3>
        <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1">
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          New Skill
        </Button>
      </div>

      {/* Main content */}
      <div className="flex gap-0 md:gap-4 flex-1 min-h-0">
        {/* Left: skill list — full width on mobile, w-64 on desktop */}
        <div className={cn(
          "flex flex-col border border-border rounded-lg overflow-hidden",
          "w-full md:w-64 md:shrink-0",
          selected ? "hidden md:flex" : "flex"
        )}>
          <div className="p-2 border-b border-border">
            <div className="relative">
              <HugeiconsIcon icon={Search01Icon} className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search skills..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {projectSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Project
                  </span>
                  {projectSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {globalSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Global
                  </span>
                  {globalSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {installedSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Installed
                  </span>
                  {installedSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {pluginSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Plugins
                  </span>
                  {pluginSkills.map((skill) => (
                    <SkillListItem
                      key={skill.filePath || `${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {filtered.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <HugeiconsIcon icon={ZapIcon} className="h-8 w-8 opacity-40" />
                  <p className="text-xs">
                    {search ? "No skills match your search" : "No skills yet"}
                  </p>
                  {!search && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setShowCreate(true)}
                      className="gap-1"
                    >
                      <HugeiconsIcon icon={PlusSignIcon} className="h-3 w-3" />
                      Create one
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: editor — full width on mobile, flex-1 on desktop */}
        <div className={cn(
          "flex flex-col min-w-0 border border-border rounded-lg overflow-hidden",
          "w-full md:flex-1",
          selected ? "flex" : "hidden md:flex"
        )}>
          {selected ? (
            <>
              {/* Mobile back button */}
              <button
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground border-b border-border md:hidden"
                onClick={() => setSelected(null)}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} className="h-4 w-4" />
                Back to list
              </button>
              <div className="flex-1 min-h-0">
                <SkillEditor
                  key={`${selected.source}:${selected.name}`}
                  skill={selected}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <HugeiconsIcon icon={ZapIcon} className="h-12 w-12 opacity-30" />
              <div className="text-center">
                <p className="text-sm font-medium">No skill selected</p>
                <p className="text-xs">
                  Select a skill from the list or create a new one
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(true)}
                className="gap-1"
              >
                <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
                New Skill
              </Button>
            </div>
          )}
        </div>
      </div>

      <CreateSkillDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={handleCreate}
        workingDirectory={workingDirectory}
      />
    </div>
  );
}
