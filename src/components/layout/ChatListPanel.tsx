"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Search01Icon,
  Notification02Icon,
  FileImportIcon,
  Folder01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlusSignIcon,
  FolderOpenIcon,
  Tick01Icon,
  Cancel01Icon,
  RefreshIcon,
  CleanIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { AlertTriangle } from 'lucide-react';
import { useGitSync } from '@/hooks/useGitSync';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePanel } from "@/hooks/usePanel";
import { ImportSessionDialog } from "./ImportSessionDialog";
import { FolderPicker } from "@/components/chat/FolderPicker";
import type { ChatSession } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
  onClose?: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 7) return `${diffDay}d`;
  return date.toLocaleDateString();
}

const COLLAPSED_PROJECTS_KEY = "codepilot:collapsed-projects";
const MAX_VISIBLE_SESSIONS = 5;

function loadCollapsedProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
}

interface ProjectGroup {
  workingDirectory: string;
  displayName: string;
  sessions: ChatSession[];
  latestUpdatedAt: number;
}

function groupSessionsByProject(sessions: ChatSession[]): ProjectGroup[] {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const key = session.working_directory || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(session);
  }

  const groups: ProjectGroup[] = [];
  for (const [wd, groupSessions] of map) {
    // Sort sessions within group by updated_at DESC
    groupSessions.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const displayName =
      wd === ""
        ? "No Project"
        : groupSessions[0]?.project_name || wd.split("/").pop() || wd;
    const latestUpdatedAt = new Date(groupSessions[0].updated_at).getTime();
    groups.push({
      workingDirectory: wd,
      displayName,
      sessions: groupSessions,
      latestUpdatedAt,
    });
  }

  // Sort groups by most recently active first
  groups.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
  return groups;
}


export function ChatListPanel({ open, width, onClose }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { streamingSessionId, pendingApprovalSessionId, streamingSessions } = usePanel();
  const { syncStates, pullProject, pullAll, isAnyLoading } = useGitSync();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTab, setSearchTab] = useState<'sessions' | 'content'>('sessions');
  const [contentResults, setContentResults] = useState<Array<{
    message_id: string;
    session_id: string;
    session_title: string;
    project_name: string;
    working_directory: string;
    role: string;
    snippet: string;
    created_at: string;
  }>>([]);
  const [contentTotal, setContentTotal] = useState(0);
  const [isSearchingContent, setIsSearchingContent] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => loadCollapsedProjects()
  );
  const [creatingChat, setCreatingChat] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const navigateToOrganize = useCallback((projectPath?: string) => {
    const href = projectPath
      ? `/chat/organize?project=${encodeURIComponent(projectPath)}`
      : '/chat/organize';
    router.push(href);
    onClose?.();
  }, [router, onClose]);

  const handleNewChat = useCallback(async () => {
    const lastDir = typeof window !== 'undefined'
      ? localStorage.getItem("codepilot:last-working-directory")
      : null;

    if (!lastDir) {
      // No saved directory — let user pick one
      setFolderPickerOpen(true);
      return;
    }

    // Validate the saved directory still exists
    setCreatingChat(true);
    try {
      const checkRes = await fetch(
        `/api/files/browse?dir=${encodeURIComponent(lastDir)}`
      );
      if (!checkRes.ok) {
        // Directory is gone — clear stale value and prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        setFolderPickerOpen(true);
        return;
      }

      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: lastDir }),
      });
      if (!res.ok) {
        // Backend rejected it (e.g. INVALID_DIRECTORY) — prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        setFolderPickerOpen(true);
        return;
      }
      const data = await res.json();
      router.push(`/chat/${data.session.id}`);
      window.dispatchEvent(new CustomEvent("session-created"));
    } catch {
      setFolderPickerOpen(true);
    } finally {
      setCreatingChat(false);
    }
  }, [router]);

  const toggleProject = useCallback((wd: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(wd)) next.delete(wd);
      else next.add(wd);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch {
      // API may not be available yet
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Refresh session list when navigating
  useEffect(() => {
    fetchSessions();
  }, [pathname, fetchSessions]);

  // Refresh session list when a session is created or updated
  useEffect(() => {
    const handler = () => fetchSessions();
    window.addEventListener("session-created", handler);
    window.addEventListener("session-updated", handler);
    return () => {
      window.removeEventListener("session-created", handler);
      window.removeEventListener("session-updated", handler);
    };
  }, [fetchSessions]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string,
    sessionTitle?: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const title = sessionTitle?.trim() || "Untitled";
    if (!confirm(`Delete this conversation?\n\n"${title}"`)) return;
    setDeletingSession(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (pathname === `/chat/${sessionId}`) {
          router.push("/chat");
        }
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingSession(null);
    }
  };

  const handleCreateSessionInProject = async (
    e: React.MouseEvent,
    workingDirectory: string
  ) => {
    e.stopPropagation();
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: workingDirectory }),
      });
      if (res.ok) {
        const data = await res.json();
        // Auto-expand the project so the new chat is visible
        setCollapsedProjects((prev) => {
          if (!prev.has(workingDirectory)) return prev;
          const next = new Set(prev);
          next.delete(workingDirectory);
          saveCollapsedProjects(next);
          return next;
        });
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
        // Scroll the new session into view after fetch + render completes
        const scrollToSession = () => {
          const el = document.querySelector(`[data-session-id="${data.session.id}"]`);
          if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } else {
            // DOM not yet updated — retry once after a short delay
            setTimeout(() => {
              document.querySelector(`[data-session-id="${data.session.id}"]`)
                ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 300);
          }
        };
        // Give fetchSessions time to complete and React to render
        setTimeout(scrollToSession, 100);
      }
    } catch {
      // Silently fail
    }
  };

  const handleFolderSelect = async (path: string) => {
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: path }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // Silently fail
    }
  };

  // Content search with debounce
  const searchContent = useCallback(async (query: string) => {
    if (!query.trim()) {
      setContentResults([]);
      setContentTotal(0);
      return;
    }
    setIsSearchingContent(true);
    try {
      const res = await fetch(`/api/chat/sessions/search?q=${encodeURIComponent(query)}&limit=50`);
      if (res.ok) {
        const data = await res.json();
        setContentResults(data.results || []);
        setContentTotal(data.total || 0);
      }
    } catch {
      // ignore
    } finally {
      setIsSearchingContent(false);
    }
  }, []);

  // Debounced content search when query or tab changes
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (searchQuery.trim() && searchTab === 'content') {
      searchDebounceRef.current = setTimeout(() => searchContent(searchQuery), 300);
    } else {
      setContentResults([]);
      setContentTotal(0);
    }
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchQuery, searchTab, searchContent]);

  const isSearching = searchQuery.length > 0;

  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.project_name &&
            s.project_name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : sessions;

  const projectGroups = useMemo(
    () => groupSessionsByProject(filteredSessions),
    [filteredSessions]
  );

  if (!open) return null;

  return (
    <aside
      data-mobile-overlay=""
      className={cn(
        "flex flex-col overflow-hidden bg-sidebar",
        "fixed inset-0 z-50",
        "md:static md:inset-auto md:z-auto md:h-full md:shrink-0"
      )}
      style={{ width: width ?? 240 }}
    >
      {/* Mobile header with close button */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3 md:hidden">
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onClose}>
          <HugeiconsIcon icon={ArrowRight01Icon} className="h-4 w-4 rotate-180" />
          Back
        </Button>
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">
          Threads
        </span>
      </div>
      {/* Desktop header */}
      <div className="hidden h-12 shrink-0 items-center justify-between px-3 pl-6 md:flex">
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">
          Threads
        </span>
      </div>

      {/* New Chat + overflow menu */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-center gap-1.5 h-8 text-xs"
          disabled={creatingChat}
          onClick={handleNewChat}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          New Chat
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 shrink-0"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} className="h-3.5 w-3.5" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setFolderPickerOpen(true)}>
              <HugeiconsIcon icon={FolderOpenIcon} className="h-3.5 w-3.5" />
              Open project folder
            </DropdownMenuItem>
            {projectGroups.some(g => g.workingDirectory !== '') && (
              <DropdownMenuItem
                disabled={isAnyLoading}
                onSelect={() =>
                  pullAll(
                    projectGroups
                      .filter(g => g.workingDirectory !== '')
                      .map(g => ({ dir: g.workingDirectory, displayName: g.displayName }))
                  )
                }
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  className={cn('h-3.5 w-3.5', isAnyLoading && 'animate-spin')}
                />
                Pull all projects
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => navigateToOrganize()}>
              <HugeiconsIcon icon={CleanIcon} className="h-3.5 w-3.5" />
              Organize sessions
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search threads..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (!e.target.value.trim()) setSearchTab('sessions');
            }}
            className="h-8 pl-7 text-xs"
          />
        </div>
        {searchQuery.trim() && (
          <div className="flex mt-1.5 gap-1">
            <button
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                searchTab === 'sessions'
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              onClick={() => setSearchTab('sessions')}
            >
              Sessions
            </button>
            <button
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                searchTab === 'content'
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              onClick={() => setSearchTab('content')}
            >
              Content
              {searchTab === 'content' && contentTotal > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">({contentTotal})</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Import CLI Session + Collapse/Expand all */}
      <div className="flex items-center gap-1 px-3 pb-1">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start gap-2 h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setImportDialogOpen(true)}
        >
          <HugeiconsIcon icon={FileImportIcon} className="h-3 w-3" />
          Import CLI Session
        </Button>
        {projectGroups.length > 1 && (
          <button
            className="shrink-0 px-1.5 py-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors rounded"
            onClick={() => {
              const allCollapsed = projectGroups.every((g) => collapsedProjects.has(g.workingDirectory));
              if (allCollapsed) {
                setCollapsedProjects(new Set());
                saveCollapsedProjects(new Set());
              } else {
                const all = new Set(projectGroups.map((g) => g.workingDirectory));
                setCollapsedProjects(all);
                saveCollapsedProjects(all);
                setExpandedGroups(new Set());
              }
            }}
          >
            {projectGroups.every((g) => collapsedProjects.has(g.workingDirectory))
              ? "Expand all"
              : "Collapse all"}
          </button>
        )}
      </div>

      {/* Session list grouped by project */}
      <ScrollArea className="flex-1 min-h-0 px-3 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full [&_[data-slot=scroll-area-viewport]>div]:max-w-full">
        {isSearching && searchTab === 'content' ? (
          <div className="flex w-full min-w-0 flex-col gap-1 pb-3">
            {isSearchingContent ? (
              <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
                Searching...
              </p>
            ) : contentResults.length === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
                No matching content
              </p>
            ) : (
              contentResults.map((result) => (
                <Link
                  key={`${result.session_id}-${result.message_id}`}
                  href={`/chat/${result.session_id}?highlight=${result.message_id}`}
                  onClick={() => onClose?.()}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 transition-colors hover:bg-accent/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-medium text-sidebar-foreground">
                      {result.session_title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/40">
                      {formatRelativeTime(result.created_at)}
                    </span>
                  </div>
                  <p
                    className="text-[11px] leading-relaxed text-muted-foreground line-clamp-2 [&_mark]:bg-yellow-200 [&_mark]:text-foreground dark:[&_mark]:bg-yellow-500/30"
                    dangerouslySetInnerHTML={{ __html: result.snippet }}
                  />
                  <span className="text-[10px] text-muted-foreground/40">
                    {result.project_name || result.working_directory.split('/').pop()}
                  </span>
                </Link>
              ))
            )}
          </div>
        ) : (
          <div className="flex w-full min-w-0 flex-col pb-3">
            {filteredSessions.length === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
                {searchQuery ? "No matching threads" : "No conversations yet"}
              </p>
            ) : (
              projectGroups.map((group) => {
                const isCollapsed =
                  !isSearching && collapsedProjects.has(group.workingDirectory);
                return (
                  <div key={group.workingDirectory || "__no_project"} className="mt-1 w-full min-w-0 first:mt-0">
                    {/* Folder header */}
                    <div
                      className={cn(
                        "group/folder flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 cursor-pointer select-none transition-colors",
                        "hover:bg-accent/50"
                      )}
                      onClick={() => toggleProject(group.workingDirectory)}
                    >
                      <HugeiconsIcon
                        icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                      />
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-sidebar-foreground">
                        {group.displayName}
                      </span>
                      {/* Status indicator — briefly shows pull result, then disappears */}
                      {group.workingDirectory !== '' && (() => {
                        const state = syncStates.get(group.workingDirectory);
                        if (!state || state.status === 'idle' || state.status === 'loading' || state.status === 'not-git') return null;
                        if (state.status === 'success' || state.status === 'up-to-date') {
                          return (
                            <HugeiconsIcon
                              icon={Tick01Icon}
                              className="h-3 w-3 shrink-0 text-green-500"
                            />
                          );
                        }
                        if (state.status === 'dirty') {
                          return <AlertTriangle className="h-3 w-3 shrink-0 text-yellow-500" />;
                        }
                        // error
                        return (
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            className="h-3 w-3 shrink-0 text-red-500"
                          />
                        );
                      })()}

                      {/* Per-project sync button */}
                      {group.workingDirectory !== '' && (() => {
                        const syncState = syncStates.get(group.workingDirectory);
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className={cn(
                                  "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                                  "opacity-100 md:opacity-0 md:group-hover/folder:opacity-100"
                                )}
                                disabled={syncState?.status === 'loading'}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pullProject(group.workingDirectory, group.displayName);
                                }}
                              >
                                <HugeiconsIcon
                                  icon={RefreshIcon}
                                  className={cn(
                                    'h-3 w-3',
                                    syncState?.status === 'loading' && 'animate-spin'
                                  )}
                                />
                                <span className="sr-only">Pull {group.displayName}</span>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="right">Pull {group.displayName}</TooltipContent>
                          </Tooltip>
                        );
                      })()}

                      {/* New chat in project button */}
                      {group.workingDirectory !== "" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className={cn(
                                "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                                "opacity-100 md:opacity-0 md:group-hover/folder:opacity-100"
                              )}
                              onClick={(e) =>
                                handleCreateSessionInProject(
                                  e,
                                  group.workingDirectory
                                )
                              }
                            >
                              <HugeiconsIcon
                                icon={PlusSignIcon}
                                className="h-3 w-3"
                              />
                              <span className="sr-only">
                                New chat in {group.displayName}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            New chat in {group.displayName}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {group.workingDirectory !== '' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="h-5 w-5 shrink-0 opacity-100 md:opacity-0 md:group-hover/folder:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateToOrganize(group.workingDirectory);
                              }}
                            >
                              <HugeiconsIcon icon={CleanIcon} className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="right">Organize {group.displayName}</TooltipContent>
                        </Tooltip>
                      )}
                    </div>

                    {/* Session items */}
                    {!isCollapsed && (() => {
                      const isGroupExpanded = expandedGroups.has(group.workingDirectory);
                      const hasMore = group.sessions.length > MAX_VISIBLE_SESSIONS;
                      const visibleSessions = hasMore && !isGroupExpanded
                        ? group.sessions.slice(0, MAX_VISIBLE_SESSIONS)
                        : group.sessions;
                      const hiddenCount = group.sessions.length - MAX_VISIBLE_SESSIONS;

                      return (
                        <div className="mt-0.5 flex w-full min-w-0 flex-col gap-0.5">
                          {visibleSessions.map((session) => {
                            const isActive = pathname === `/chat/${session.id}`;
                            const isDeleting = deletingSession === session.id;
                            const streamingInfo = streamingSessions.get(session.id);
                            const isSessionStreaming = !!streamingInfo || streamingSessionId === session.id;
                            const needsApproval = streamingInfo?.status === 'waiting_permission'
                              || streamingInfo?.status === 'waiting_input'
                              || pendingApprovalSessionId === session.id;

                            return (
                              <div
                                key={session.id}
                                data-session-id={session.id}
                                className="group relative w-full min-w-0"
                              >
                                <Link
                                  href={`/chat/${session.id}`}
                                  onClick={() => onClose?.()}
                                  className={cn(
                                    "flex w-full min-w-0 items-center gap-1.5 rounded-md pl-7 pr-8 md:pr-2 py-1.5 transition-all duration-150",
                                    isActive
                                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                      : "text-sidebar-foreground hover:bg-accent/50"
                                  )}
                                >
                                  {/* Streaming pulse indicator */}
                                  {isSessionStreaming && (
                                    <span className="relative flex h-2 w-2 shrink-0">
                                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                    </span>
                                  )}
                                  {/* Approval indicator */}
                                  {needsApproval && (
                                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                                      <HugeiconsIcon
                                        icon={Notification02Icon}
                                        className="h-2.5 w-2.5 text-amber-500"
                                      />
                                    </span>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <span className="line-clamp-1 text-[12px] font-medium leading-tight break-all">
                                      {session.title}
                                    </span>
                                    {isSessionStreaming && streamingInfo && (
                                      <span className="line-clamp-1 text-[10px] text-muted-foreground/60 leading-tight">
                                        {streamingInfo.statusText}
                                      </span>
                                    )}
                                  </div>
                                  {!isSessionStreaming && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-[10px] text-muted-foreground/40">
                                        {formatRelativeTime(session.updated_at)}
                                      </span>
                                    </div>
                                  )}
                                </Link>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      className={cn(
                                        "absolute right-1 top-1 bg-sidebar text-muted-foreground/60 hover:text-destructive transition-opacity",
                                        "opacity-100 md:opacity-0 md:group-hover:opacity-100",
                                        isDeleting && "opacity-100"
                                      )}
                                      onClick={(e) =>
                                        handleDeleteSession(e, session.id, session.title)
                                      }
                                      disabled={isDeleting}
                                    >
                                      <HugeiconsIcon
                                        icon={Delete02Icon}
                                        className="h-3 w-3"
                                      />
                                      <span className="sr-only">
                                        Delete session
                                      </span>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">
                                    Delete
                                  </TooltipContent>
                                </Tooltip>
                              </div>
                            );
                          })}
                          {hasMore && (
                            <button
                              className="pl-7 py-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground text-left transition-colors"
                              onClick={() => setExpandedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.workingDirectory)) next.delete(group.workingDirectory);
                                else next.add(group.workingDirectory);
                                return next;
                              })}
                            >
                              {isGroupExpanded ? "Show less" : `${hiddenCount} more...`}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>
        )}
      </ScrollArea>

      {/* Import CLI Session Dialog */}
      <ImportSessionDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />

      {/* Folder Picker Dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderSelect}
      />
    </aside>
  );
}
