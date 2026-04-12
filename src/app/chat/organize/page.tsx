'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import type {
  OrganizeConfig,
  OrganizeSuggestion,
  OrganizeSSEEvent,
  OrganizeStatusResponse,
  ExecuteSSEEvent,
} from '@/types/organize';
import { DEFAULT_ORGANIZE_CONFIG } from '@/types/organize';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Loading02Icon,
  ArrowLeft01Icon,
  Delete01Icon,
  PencilEdit01Icon,
  Tick01Icon,
  CheckmarkCircle01Icon,
  CleanIcon,
  PlayIcon,
  Cancel01Icon,
} from '@hugeicons/core-free-icons';

type Phase = 'config' | 'analyzing' | 'results' | 'executing' | 'done';

interface ExecutionSummary {
  success: number;
  failed: number;
  failures: Array<{ sessionId: string; error: string }>;
}

export default function OrganizePage() {
  const searchParams = useSearchParams();
  const projectScope = searchParams.get('project');

  // --- Config state ---
  const [trustMode, setTrustMode] = useState(false);
  const [cleanupCli, setCleanupCli] = useState(false);

  // --- Phase state ---
  const [phase, setPhase] = useState<Phase>('config');
  const [taskId, setTaskId] = useState<string | null>(null);

  // --- Analysis progress ---
  const [analysisPhase, setAnalysisPhase] = useState<'rules' | 'ai'>('rules');
  const [analysisCompleted, setAnalysisCompleted] = useState(0);
  const [analysisTotal, setAnalysisTotal] = useState(0);

  // --- Suggestions ---
  const [suggestions, setSuggestions] = useState<OrganizeSuggestion[]>([]);

  // --- Selection state ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- Editable titles for rename suggestions ---
  const [editedTitles, setEditedTitles] = useState<Record<string, string>>({});

  // --- Execution progress ---
  const [execCompleted, setExecCompleted] = useState(0);
  const [execTotal, setExecTotal] = useState(0);
  const [execSummary, setExecSummary] = useState<ExecutionSummary | null>(null);

  // --- Error ---
  const [error, setError] = useState<string | null>(null);

  // --- SSE abort ref ---
  const abortRef = useRef<AbortController | null>(null);

  // --- Recovery polling ref ---
  const recoveryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derived lists
  const deleteSuggestions = suggestions.filter((s) => s.action === 'delete');
  const renameSuggestions = suggestions.filter((s) => s.action === 'rename');
  const keepSuggestions = suggestions.filter((s) => s.action === 'keep');

  // Selection counts for action bar
  const selectedDeletes = deleteSuggestions.filter((s) => selectedIds.has(s.sessionId));
  const selectedRenames = renameSuggestions.filter((s) => selectedIds.has(s.sessionId));

  // --- Toggle selection ---
  const toggleSelection = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const toggleAllInGroup = useCallback(
    (group: OrganizeSuggestion[]) => {
      const groupIds = group.map((s) => s.sessionId);
      const allSelected = groupIds.every((id) => selectedIds.has(id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allSelected) {
          groupIds.forEach((id) => next.delete(id));
        } else {
          groupIds.forEach((id) => next.add(id));
        }
        return next;
      });
    },
    [selectedIds],
  );

  // --- Update edited title ---
  const updateEditedTitle = useCallback((sessionId: string, title: string) => {
    setEditedTitles((prev) => ({ ...prev, [sessionId]: title }));
  }, []);

  // --- Check status on mount for recovery ---
  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const res = await fetch('/api/chat/sessions/organize/status');
        if (!res.ok || cancelled) return;
        const data: OrganizeStatusResponse = await res.json();

        if (!data.hasTask) return;

        if (data.status === 'running') {
          // Reconnect to running task
          setTaskId(data.taskId ?? null);
          if (data.results && data.results.length > 0) {
            setSuggestions(data.results);
          }
          if (data.progress) {
            setAnalysisPhase(data.progress.phase as 'rules' | 'ai');
            setAnalysisCompleted(data.progress.completed);
            setAnalysisTotal(data.progress.total);
          }
          if (data.config) {
            setTrustMode(data.config.trustMode);
            setCleanupCli(data.config.cleanupCli);
          }
          setPhase('analyzing');
          // Start recovery polling
          startRecoveryPolling();
        } else if (data.status === 'done' && data.results) {
          setSuggestions(data.results);
          if (data.config) {
            setTrustMode(data.config.trustMode);
            setCleanupCli(data.config.cleanupCli);
          }
          // Auto-select delete and rename suggestions
          const ids = new Set(
            data.results
              .filter((s) => s.action === 'delete' || s.action === 'rename')
              .map((s) => s.sessionId),
          );
          setSelectedIds(ids);
          // Pre-fill edited titles
          const titles: Record<string, string> = {};
          data.results.forEach((s) => {
            if (s.action === 'rename' && s.suggestedTitle) {
              titles[s.sessionId] = s.suggestedTitle;
            }
          });
          setEditedTitles(titles);
          setPhase('results');
        }
      } catch {
        // Status check failed, stay on config
      }
    }

    checkStatus();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Recovery polling ---
  const startRecoveryPolling = useCallback(() => {
    if (recoveryIntervalRef.current) return;

    recoveryIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/chat/sessions/organize/status');
        if (!res.ok) return;
        const data: OrganizeStatusResponse = await res.json();

        if (data.results && data.results.length > 0) {
          setSuggestions(data.results);
        }
        if (data.progress) {
          setAnalysisPhase(data.progress.phase as 'rules' | 'ai');
          setAnalysisCompleted(data.progress.completed);
          setAnalysisTotal(data.progress.total);
        }

        if (data.status === 'done' && data.results) {
          // Analysis completed during polling
          stopRecoveryPolling();
          const ids = new Set(
            data.results
              .filter((s) => s.action === 'delete' || s.action === 'rename')
              .map((s) => s.sessionId),
          );
          setSelectedIds(ids);
          const titles: Record<string, string> = {};
          data.results.forEach((s) => {
            if (s.action === 'rename' && s.suggestedTitle) {
              titles[s.sessionId] = s.suggestedTitle;
            }
          });
          setEditedTitles(titles);
          setPhase('results');
        } else if (data.status === 'error') {
          stopRecoveryPolling();
          setError('分析过程中出现错误');
          setPhase('config');
        }
      } catch {
        // Polling failed, will retry next interval
      }
    }, 3000);
  }, []);

  const stopRecoveryPolling = useCallback(() => {
    if (recoveryIntervalRef.current) {
      clearInterval(recoveryIntervalRef.current);
      recoveryIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecoveryPolling();
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [stopRecoveryPolling]);

  // --- Start analysis ---
  const startAnalysis = useCallback(async () => {
    setError(null);
    setPhase('analyzing');
    setSuggestions([]);
    setSelectedIds(new Set());
    setEditedTitles({});
    setAnalysisCompleted(0);
    setAnalysisTotal(0);
    setAnalysisPhase('rules');

    const config: Partial<OrganizeConfig> = {
      ...DEFAULT_ORGANIZE_CONFIG,
      trustMode,
      cleanupCli,
    };
    if (projectScope) {
      config.scope = projectScope;
    }

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch('/api/chat/sessions/organize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: abort.signal,
      });

      if (!res.ok) {
        throw new Error(`分析请求失败: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');

      const decoder = new TextDecoder();
      let buffer = '';
      const collectedSuggestions: OrganizeSuggestion[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event: OrganizeSSEEvent = JSON.parse(jsonStr);

            if (event.type === 'progress') {
              setAnalysisPhase(event.phase);
              setAnalysisCompleted(event.completed);
              setAnalysisTotal(event.total);
            } else if (event.type === 'suggestion') {
              collectedSuggestions.push(event.data);
              setSuggestions([...collectedSuggestions]);
            } else if (event.type === 'done') {
              // Auto-select delete and rename suggestions
              const ids = new Set(
                collectedSuggestions
                  .filter((s) => s.action === 'delete' || s.action === 'rename')
                  .map((s) => s.sessionId),
              );
              setSelectedIds(ids);
              // Pre-fill edited titles
              const titles: Record<string, string> = {};
              collectedSuggestions.forEach((s) => {
                if (s.action === 'rename' && s.suggestedTitle) {
                  titles[s.sessionId] = s.suggestedTitle;
                }
              });
              setEditedTitles(titles);

              if (trustMode) {
                // Trust mode: auto-execute
                setPhase('results');
                // We set results phase briefly then execute
                setTimeout(() => {
                  executeActions(collectedSuggestions, ids, titles);
                }, 500);
              } else {
                setPhase('results');
              }
            } else if (event.type === 'error') {
              setError(event.message);
              setPhase('config');
            }
          } catch {
            // JSON parse error, skip
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      // SSE connection dropped — start recovery polling
      startRecoveryPolling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trustMode, cleanupCli, projectScope, startRecoveryPolling]);

  // --- Execute actions ---
  const executeActions = useCallback(
    async (
      suggestionsOverride?: OrganizeSuggestion[],
      selectedOverride?: Set<string>,
      titlesOverride?: Record<string, string>,
    ) => {
      const currentSuggestions = suggestionsOverride ?? suggestions;
      const currentSelected = selectedOverride ?? selectedIds;
      const currentTitles = titlesOverride ?? editedTitles;

      const actions: Array<{ sessionId: string; action: 'delete' | 'rename'; newTitle?: string }> = [];

      currentSuggestions.forEach((s) => {
        if (!currentSelected.has(s.sessionId)) return;
        if (s.action === 'delete') {
          actions.push({ sessionId: s.sessionId, action: 'delete' });
        } else if (s.action === 'rename') {
          const newTitle = currentTitles[s.sessionId] || s.suggestedTitle;
          if (newTitle) {
            actions.push({ sessionId: s.sessionId, action: 'rename', newTitle });
          }
        }
      });

      if (actions.length === 0) return;

      setPhase('executing');
      setExecCompleted(0);
      setExecTotal(actions.length);
      setExecSummary(null);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch('/api/chat/sessions/organize/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: taskId || 'manual', actions, cleanupCli }),
          signal: abort.signal,
        });

        if (!res.ok) {
          throw new Error(`执行请求失败: ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('无法读取响应流');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event: ExecuteSSEEvent = JSON.parse(jsonStr);

              if (event.type === 'progress') {
                setExecCompleted(event.completed);
                setExecTotal(event.total);
              } else if (event.type === 'done') {
                setExecSummary(event.summary);
                setPhase('done');
                // Dispatch session-updated event so sidebar refreshes
                window.dispatchEvent(new CustomEvent('session-updated'));
              }
            } catch {
              // JSON parse error, skip
            }
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : '执行过程中出现错误');
        setPhase('results');
      }
    },
    [suggestions, selectedIds, editedTitles, taskId, cleanupCli],
  );

  // --- Reset to config ---
  const resetToConfig = useCallback(() => {
    setPhase('config');
    setSuggestions([]);
    setSelectedIds(new Set());
    setEditedTitles({});
    setError(null);
    setExecSummary(null);
    stopRecoveryPolling();
  }, [stopRecoveryPolling]);

  // --- Scope display ---
  const scopeLabel = projectScope
    ? `项目: ${projectScope.split('/').pop()}`
    : '全部 Sessions';

  // --- Progress percentage ---
  const analysisPct =
    analysisTotal > 0 ? Math.round((analysisCompleted / analysisTotal) * 100) : 0;
  const execPct = execTotal > 0 ? Math.round((execCompleted / execTotal) * 100) : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <a href="/chat" className="shrink-0 rounded-md p-1 hover:bg-muted">
          <HugeiconsIcon icon={ArrowLeft01Icon} className="size-5 text-muted-foreground" />
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Session 整理</h1>
          <p className="text-xs text-muted-foreground truncate">{scopeLabel}</p>
        </div>
      </div>

      {/* Main content area */}
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-2xl px-4 py-4">
          {/* --- Config phase --- */}
          {phase === 'config' && (
            <div className="space-y-6">
              {error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="space-y-4">
                {/* Trust mode */}
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <div className="min-w-0 flex-1">
                    <Label className="text-sm font-medium">
                      信任模式（跳过 Review，自动执行）
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      分析完成后自动执行所有建议操作
                    </p>
                  </div>
                  <Switch checked={trustMode} onCheckedChange={setTrustMode} />
                </div>

                {/* CLI cleanup */}
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <div className="min-w-0 flex-1">
                    <Label className="text-sm font-medium">
                      同时清理 Claude Code CLI 文件
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      删除 Session 时同时清理对应的 CLI .jsonl 文件
                    </p>
                  </div>
                  <Switch checked={cleanupCli} onCheckedChange={setCleanupCli} />
                </div>
              </div>

              <Button
                onClick={startAnalysis}
                className="w-full"
                size="lg"
              >
                <HugeiconsIcon icon={PlayIcon} className="size-4" />
                开始分析
              </Button>
            </div>
          )}

          {/* --- Analyzing phase --- */}
          {phase === 'analyzing' && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {analysisPhase === 'rules' ? '规则分析中...' : 'AI 分析中...'}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {analysisCompleted}/{analysisTotal}
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${analysisPct}%` }}
                  />
                </div>
              </div>

              {/* Real-time suggestion count */}
              {suggestions.length > 0 && (
                <div className="rounded-lg border p-4 text-sm">
                  <p className="text-muted-foreground">
                    已发现{' '}
                    <span className="font-medium text-foreground">{suggestions.length}</span>{' '}
                    条建议
                  </p>
                  <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                    {deleteSuggestions.length > 0 && (
                      <span>删除: {deleteSuggestions.length}</span>
                    )}
                    {renameSuggestions.length > 0 && (
                      <span>改名: {renameSuggestions.length}</span>
                    )}
                    {keepSuggestions.length > 0 && (
                      <span>保留: {keepSuggestions.length}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-center">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-6 animate-spin text-muted-foreground"
                />
              </div>
            </div>
          )}

          {/* --- Results phase --- */}
          {phase === 'results' && (
            <div className="space-y-4">
              <Tabs defaultValue="delete">
                <TabsList className="w-full">
                  <TabsTrigger value="delete" className="flex-1">
                    <HugeiconsIcon icon={Delete01Icon} className="size-3.5" />
                    建议删除 ({deleteSuggestions.length})
                  </TabsTrigger>
                  <TabsTrigger value="rename" className="flex-1">
                    <HugeiconsIcon icon={PencilEdit01Icon} className="size-3.5" />
                    建议改名 ({renameSuggestions.length})
                  </TabsTrigger>
                  <TabsTrigger value="keep" className="flex-1">
                    <HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
                    保留 ({keepSuggestions.length})
                  </TabsTrigger>
                </TabsList>

                {/* Delete tab */}
                <TabsContent value="delete" className="mt-3">
                  {deleteSuggestions.length === 0 ? (
                    <EmptyState text="没有建议删除的 Session" />
                  ) : (
                    <div className="space-y-2">
                      <SelectAllRow
                        group={deleteSuggestions}
                        selectedIds={selectedIds}
                        onToggle={() => toggleAllInGroup(deleteSuggestions)}
                      />
                      {deleteSuggestions.map((s) => (
                        <SuggestionCard
                          key={s.sessionId}
                          suggestion={s}
                          selected={selectedIds.has(s.sessionId)}
                          onToggle={() => toggleSelection(s.sessionId)}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Rename tab */}
                <TabsContent value="rename" className="mt-3">
                  {renameSuggestions.length === 0 ? (
                    <EmptyState text="没有建议改名的 Session" />
                  ) : (
                    <div className="space-y-2">
                      <SelectAllRow
                        group={renameSuggestions}
                        selectedIds={selectedIds}
                        onToggle={() => toggleAllInGroup(renameSuggestions)}
                      />
                      {renameSuggestions.map((s) => (
                        <RenameSuggestionCard
                          key={s.sessionId}
                          suggestion={s}
                          selected={selectedIds.has(s.sessionId)}
                          onToggle={() => toggleSelection(s.sessionId)}
                          editedTitle={editedTitles[s.sessionId] ?? s.suggestedTitle ?? ''}
                          onTitleChange={(title) => updateEditedTitle(s.sessionId, title)}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Keep tab */}
                <TabsContent value="keep" className="mt-3">
                  {keepSuggestions.length === 0 ? (
                    <EmptyState text="没有保留的 Session" />
                  ) : (
                    <div className="space-y-2">
                      {keepSuggestions.map((s) => (
                        <SuggestionCard
                          key={s.sessionId}
                          suggestion={s}
                          selected={false}
                          onToggle={() => {}}
                          readOnly
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>

              {/* Action bar */}
              {(selectedDeletes.length > 0 || selectedRenames.length > 0) && (
                <div className="sticky bottom-0 rounded-lg border bg-background p-4 shadow-md">
                  <Button onClick={() => executeActions()} className="w-full" size="lg">
                    <HugeiconsIcon icon={CleanIcon} className="size-4" />
                    执行选中操作
                    {selectedDeletes.length > 0 && selectedRenames.length > 0
                      ? `（删除 ${selectedDeletes.length} 个 + 改名 ${selectedRenames.length} 个）`
                      : selectedDeletes.length > 0
                        ? `（删除 ${selectedDeletes.length} 个）`
                        : `（改名 ${selectedRenames.length} 个）`}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* --- Executing phase --- */}
          {phase === 'executing' && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">正在执行操作...</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {execCompleted}/{execTotal}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${execPct}%` }}
                  />
                </div>
              </div>
              <div className="flex justify-center">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-6 animate-spin text-muted-foreground"
                />
              </div>
            </div>
          )}

          {/* --- Done phase --- */}
          {phase === 'done' && execSummary && (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3 rounded-lg border p-6">
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  className="size-10 text-green-500"
                />
                <h2 className="text-lg font-semibold">整理完成</h2>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>
                    成功:{' '}
                    <span className="font-medium text-foreground">
                      {execSummary.success}
                    </span>
                  </span>
                  {execSummary.failed > 0 && (
                    <span>
                      失败:{' '}
                      <span className="font-medium text-destructive">
                        {execSummary.failed}
                      </span>
                    </span>
                  )}
                </div>
                {execSummary.failures.length > 0 && (
                  <div className="w-full mt-3 space-y-1">
                    {execSummary.failures.map((f) => (
                      <div
                        key={f.sessionId}
                        className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                      >
                        {f.sessionId}: {f.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Button onClick={resetToConfig} variant="outline" className="w-full">
                返回
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// --- Sub-components ---

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function SelectAllRow({
  group,
  selectedIds,
  onToggle,
}: {
  group: OrganizeSuggestion[];
  selectedIds: Set<string>;
  onToggle: () => void;
}) {
  const allSelected = group.length > 0 && group.every((s) => selectedIds.has(s.sessionId));

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 active:bg-muted"
    >
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
          allSelected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40'
        }`}
      >
        {allSelected && (
          <HugeiconsIcon icon={Tick01Icon} className="size-3" />
        )}
      </span>
      全选
    </button>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'rule' | 'ai' }) {
  return (
    <Badge
      variant={confidence === 'rule' ? 'secondary' : 'outline'}
      className="text-[10px] px-1.5 py-0"
    >
      {confidence === 'rule' ? '规则' : 'AI'}
    </Badge>
  );
}

function SuggestionCard({
  suggestion,
  selected,
  onToggle,
  readOnly = false,
}: {
  suggestion: OrganizeSuggestion;
  selected: boolean;
  onToggle: () => void;
  readOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={readOnly ? undefined : onToggle}
      className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
        readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-muted/50 active:bg-muted'
      } ${selected ? 'border-primary/30 bg-primary/5' : ''}`}
    >
      {!readOnly && (
        <span
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40'
          }`}
        >
          {selected && (
            <HugeiconsIcon icon={Tick01Icon} className="size-3" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{suggestion.sessionTitle}</span>
          <ConfidenceBadge confidence={suggestion.confidence} />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{suggestion.reason}</p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
          {suggestion.projectName && <span>{suggestion.projectName}</span>}
          <span>{suggestion.messageCount} 条消息</span>
          <span>{formatDate(suggestion.lastUpdated)}</span>
        </div>
      </div>
    </button>
  );
}

function RenameSuggestionCard({
  suggestion,
  selected,
  onToggle,
  editedTitle,
  onTitleChange,
}: {
  suggestion: OrganizeSuggestion;
  selected: boolean;
  onToggle: () => void;
  editedTitle: string;
  onTitleChange: (title: string) => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        selected ? 'border-primary/30 bg-primary/5' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <button type="button" onClick={onToggle} className="mt-0.5 shrink-0">
          <span
            className={`flex size-4 items-center justify-center rounded border transition-colors ${
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/40'
            }`}
          >
            {selected && (
              <HugeiconsIcon icon={Tick01Icon} className="size-3" />
            )}
          </span>
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{suggestion.sessionTitle}</span>
            <ConfidenceBadge confidence={suggestion.confidence} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3 rotate-180" />
            <Input
              value={editedTitle}
              onChange={(e) => onTitleChange(e.target.value)}
              className="h-7 text-xs"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{suggestion.reason}</p>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
            {suggestion.projectName && <span>{suggestion.projectName}</span>}
            <span>{suggestion.messageCount} 条消息</span>
            <span>{formatDate(suggestion.lastUpdated)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays} 天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} 个月前`;
    return `${Math.floor(diffDays / 365)} 年前`;
  } catch {
    return dateStr;
  }
}
