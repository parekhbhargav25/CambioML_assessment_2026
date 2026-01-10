"use client";

import { PreviewMessage } from "@/components/message";
import { getDesktopURL } from "@/lib/e2b/utils";
import { useScrollToBottom } from "@/lib/use-scroll-to-bottom";
import { useChat } from "@ai-sdk/react";
import type { Message } from "ai";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Input } from "@/components/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DeployButton, ProjectInfo } from "@/components/project-info";
import { AISDKLogo } from "@/components/icons";
import { PromptSuggestions } from "@/components/prompt-suggestions";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ABORTED, cn } from "@/lib/utils";
import {
  deriveStatusFromResult,
  eventReducer,
  getEventType,
  initialEventState,
  parseToolPayload,
  parseToolResult,
  type ToolEvent,
  type ToolEventStatus,
  type ToolName,
} from "@/lib/agent-events";
import { VncViewer } from "@/components/vnc-viewer";
import { Plus, Trash2 } from "lucide-react";

const STORAGE_KEY = "computer-use:sessions";

type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

type StoredSessions = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

type MessagePart = NonNullable<Message["parts"]>[number];

type ToolInvocationPart = MessagePart & {
  type: "tool-invocation";
  toolInvocation: {
    toolCallId: string;
    toolName: string;
    state: "call" | "result";
    args: unknown;
    result?: unknown;
  };
};

const isToolInvocationPart = (
  part: MessagePart,
): part is ToolInvocationPart => part.type === "tool-invocation";

const createSessionId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const isTextPart = (
  part: MessagePart,
): part is MessagePart & { type: "text"; text: string } =>
  part.type === "text" && "text" in part && typeof part.text === "string";

const extractMessageText = (message: Message): string | undefined => {
  if (typeof message.content === "string") return message.content;
  const textPart = message.parts?.find(isTextPart);
  return textPart?.text;
};

const deriveSessionTitle = (messages: Message[], fallback: string) => {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage ? extractMessageText(firstUserMessage) : undefined;
  if (!text) return fallback;
  return text.trim().slice(0, 48) || fallback;
};

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return "--";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

const getStatusTone = (status: ToolEventStatus) => {
  switch (status) {
    case "running":
      return "text-amber-600";
    case "success":
      return "text-emerald-600";
    case "aborted":
      return "text-orange-600";
    case "error":
      return "text-rose-600";
    default:
      return "text-zinc-600";
  }
};

const normalizeToolName = (toolName: string): ToolName => {
  if (toolName === "computer" || toolName === "bash") return toolName;
  return "unknown";
};

export default function Chat() {
  const [desktopContainerRef, desktopEndRef] = useScrollToBottom();
  const [isInitializing, setIsInitializing] = useState(true);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"chat" | "desktop">("chat");

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const sessionsRef = useRef<ChatSession[]>([]);

  const [eventState, dispatchEvent] = useReducer(
    eventReducer,
    initialEventState,
  );
  const seenCallsRef = useRef<Set<string>>(new Set());
  const seenResultsRef = useRef<Set<string>>(new Set());
  const callStartRef = useRef<Record<string, number>>({});

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    stop: stopGeneration,
    append,
    setMessages,
  } = useChat({
    api: "/api/chat",
    id: sandboxId ?? undefined,
    body: {
      sandboxId,
    },
    maxSteps: 30,
    onError: (error) => {
      console.error(error);
      toast.error("There was an error", {
        description: "Please try again later.",
        richColors: true,
        position: "top-center",
      });
    },
  });

  const stop = () => {
    stopGeneration();

    const lastMessage = messages.at(-1);
    const lastMessageLastPart = lastMessage?.parts.at(-1);
    if (
      lastMessage?.role === "assistant" &&
      lastMessageLastPart?.type === "tool-invocation"
    ) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          ...lastMessage,
          parts: [
            ...lastMessage.parts.slice(0, -1),
            {
              ...lastMessageLastPart,
              toolInvocation: {
                ...lastMessageLastPart.toolInvocation,
                state: "result",
                result: ABORTED,
              },
            },
          ],
        },
      ]);
    }
  };

  const isLoading = status !== "ready";

  const refreshDesktop = useCallback(async () => {
    try {
      setIsInitializing(true);
      const { streamUrl, id } = await getDesktopURL(sandboxId || undefined);
      setStreamUrl(streamUrl);
      setSandboxId(id);
    } catch (err) {
      console.error("Failed to refresh desktop:", err);
    } finally {
      setIsInitializing(false);
    }
  }, [sandboxId]);

  useEffect(() => {
    if (!sandboxId) return;

    const killDesktop = () => {
      if (!sandboxId) return;
      navigator.sendBeacon(
        `/api/kill-desktop?sandboxId=${encodeURIComponent(sandboxId)}`,
      );
    };

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    if (isIOS || isSafari) {
      window.addEventListener("pagehide", killDesktop);

      return () => {
        window.removeEventListener("pagehide", killDesktop);
        killDesktop();
      };
    }

    window.addEventListener("beforeunload", killDesktop);

    return () => {
      window.removeEventListener("beforeunload", killDesktop);
      killDesktop();
    };
  }, [sandboxId]);

  useEffect(() => {
    const init = async () => {
      try {
        setIsInitializing(true);
        const { streamUrl, id } = await getDesktopURL(sandboxId ?? undefined);
        setStreamUrl(streamUrl);
        setSandboxId(id);
      } catch (err) {
        console.error("Failed to initialize desktop:", err);
        toast.error("Failed to initialize desktop");
      } finally {
        setIsInitializing(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredSessions;
        if (parsed.sessions?.length) {
          setSessions(parsed.sessions);
          const nextActiveId =
            parsed.activeSessionId ?? parsed.sessions[0].id ?? null;
          setActiveSessionId(nextActiveId);
          const active = parsed.sessions.find(
            (session) => session.id === nextActiveId,
          );
          setMessages(active?.messages ?? []);
          setHasHydrated(true);
          return;
        }
      } catch (error) {
        console.error("Failed to parse stored sessions:", error);
      }
    }

    const newSession: ChatSession = {
      id: createSessionId(),
      title: "New session",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setSessions([newSession]);
    setActiveSessionId(newSession.id);
    setMessages([]);
    setHasHydrated(true);
  }, [setMessages]);

  useEffect(() => {
    if (!hasHydrated) return;
    const payload: StoredSessions = {
      sessions,
      activeSessionId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [sessions, activeSessionId, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated || !activeSessionId) return;
    const active = sessionsRef.current.find(
      (session) => session.id === activeSessionId,
    );
    if (!active) return;
    setMessages(active.messages ?? []);
  }, [activeSessionId, hasHydrated, setMessages]);

  useEffect(() => {
    if (!hasHydrated || !activeSessionId) return;

    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== activeSessionId) return session;
        const title = deriveSessionTitle(messages, session.title);
        return {
          ...session,
          title,
          messages,
          updatedAt: Date.now(),
        };
      }),
    );
  }, [messages, activeSessionId, hasHydrated]);

  const createSession = useCallback(() => {
    const newSession: ChatSession = {
      id: createSessionId(),
      title: "New session",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setMessages([]);
  }, [setMessages]);

  const deleteSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      if (sessionId !== activeSessionId) return;

      const remaining = sessionsRef.current.filter(
        (session) => session.id !== sessionId,
      );
      const nextSession = remaining[0];
      if (!nextSession) {
        const newSession: ChatSession = {
          id: createSessionId(),
          title: "New session",
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setSessions([newSession]);
        setActiveSessionId(newSession.id);
        setMessages([]);
        return;
      }
      setActiveSessionId(nextSession.id);
      setMessages(nextSession.messages);
    },
    [activeSessionId, setMessages],
  );

  useEffect(() => {
    if (!hasHydrated) return;
    dispatchEvent({ type: "reset" });
    seenCallsRef.current = new Set();
    seenResultsRef.current = new Set();
    callStartRef.current = {};
  }, [activeSessionId, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;

    messages.forEach((message) => {
      message.parts?.forEach((part) => {
        if (!isToolInvocationPart(part)) return;

        const { toolCallId, toolName, state, args, result } =
          part.toolInvocation;
        if (!toolCallId) return;

        if (state === "call" && !seenCallsRef.current.has(toolCallId)) {
          seenCallsRef.current.add(toolCallId);
          const timestamp = Date.now();
          callStartRef.current[toolCallId] = timestamp;

          dispatchEvent({
            type: "register-call",
            event: {
              id: toolCallId,
              toolName: normalizeToolName(toolName),
              timestamp,
              status: "running",
              payload: parseToolPayload(toolName, args),
            },
          });
        }

        if (state === "result" && !seenResultsRef.current.has(toolCallId)) {
          seenResultsRef.current.add(toolCallId);
          const startedAt = callStartRef.current[toolCallId] ?? Date.now();
          const parsedResult = parseToolResult(result);
          const status = deriveStatusFromResult(parsedResult);

          dispatchEvent({
            type: "register-result",
            id: toolCallId,
            status,
            durationMs: Math.max(0, Date.now() - startedAt),
            result: parsedResult,
          });
        }
      });
    });
  }, [messages, hasHydrated]);

  const events = useMemo<ToolEvent[]>(
    () =>
      eventState.order
        .map((id) => eventState.byId[id])
        .filter((event): event is ToolEvent => Boolean(event)),
    [eventState],
  );

  const eventCounts = useMemo(() => {
    return events.reduce<Record<string, number>>((acc, event) => {
      const type = getEventType(event);
      acc[type] = (acc[type] ?? 0) + 1;
      return acc;
    }, {});
  }, [events]);

  const agentStatus = useMemo(() => {
    const hasRunning = events.some((event) => event.status === "running");
    if (hasRunning) return "Acting";
    if (status === "submitted" || status === "streaming") return "Thinking";
    return "Idle";
  }, [events, status]);

  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  useEffect(() => {
    const latestId = events.at(-1)?.id ?? null;
    if (latestId) {
      setExpandedEventId(latestId);
    }
  }, [events, activeSessionId]);

  const renderEventDetails = (event: ToolEvent) => {
    const payload = JSON.stringify(event.payload, null, 2);
    const result = event.result ? JSON.stringify(event.result, null, 2) : "--";

    return (
      <div className="space-y-2">
        <div className="text-xs text-zinc-500">Payload</div>
        <pre className="text-xs bg-zinc-950 text-zinc-100 rounded-md p-3 overflow-x-auto">
          {payload}
        </pre>
        <div className="text-xs text-zinc-500">Result</div>
        <pre className="text-xs bg-zinc-950 text-zinc-100 rounded-md p-3 overflow-x-auto">
          {result}
        </pre>
      </div>
    );
  };

  return (
    <div className="flex h-dvh relative bg-zinc-100">
      <div className="w-full hidden lg:block">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel
            defaultSize={38}
            minSize={28}
            className="flex flex-col border-r border-zinc-200 bg-white"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
              <div className="flex items-center gap-3">
                <AISDKLogo />
                <span className="text-xs text-zinc-500">{agentStatus}</span>
              </div>
              <div className="flex items-center gap-2">
                <DeployButton />
                <Button size="sm" variant="secondary" onClick={createSession}>
                  <Plus className="h-4 w-4" />
                  New
                </Button>
              </div>
            </div>

            <div className="border-b border-zinc-200 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
                Sessions
              </div>
              <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2 text-sm transition",
                      session.id === activeSessionId
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white hover:border-zinc-400",
                    )}
                  >
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => setActiveSessionId(session.id)}
                    >
                      <div className="font-medium line-clamp-1">
                        {session.title}
                      </div>
                      <div
                        className={cn(
                          "text-xs",
                          session.id === activeSessionId
                            ? "text-zinc-200"
                            : "text-zinc-500",
                        )}
                      >
                        Updated {formatTimestamp(session.updatedAt)}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "ml-2",
                        session.id === activeSessionId
                          ? "text-white hover:bg-white/10"
                          : "text-zinc-500",
                      )}
                      onClick={() => deleteSession(session.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="flex-1 space-y-6 py-4 overflow-y-auto px-4"
              ref={desktopContainerRef}
            >
              {messages.length === 0 ? <ProjectInfo /> : null}
              {messages.map((message, i) => (
                <PreviewMessage
                  message={message}
                  key={message.id}
                  isLoading={isLoading}
                  status={status}
                  isLatestMessage={i === messages.length - 1}
                />
              ))}
              <div ref={desktopEndRef} className="pb-2" />
            </div>

            {messages.length === 0 && (
              <PromptSuggestions
                disabled={isInitializing}
                submitPrompt={(prompt: string) =>
                  append({ role: "user", content: prompt })
                }
              />
            )}

            <div className="border-t border-zinc-200 bg-white px-4 py-3">
              <details className="group rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-3">
                <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-amber-900">
                  Debug event store
                  <span className="text-xs text-amber-700">
                    {events.length} events
                  </span>
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2 text-xs text-amber-900">
                    {Object.entries(eventCounts).map(([type, count]) => (
                      <span
                        key={type}
                        className="rounded-full border border-amber-200 bg-white px-2 py-1"
                      >
                        {type}: {count}
                      </span>
                    ))}
                    {Object.keys(eventCounts).length === 0 && (
                      <span className="text-amber-700">No events yet</span>
                    )}
                  </div>
                  <pre className="max-h-56 overflow-y-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-100">
                    {JSON.stringify(events.slice(-50), null, 2)}
                  </pre>
                </div>
              </details>
            </div>

            <div className="bg-white border-t border-zinc-200">
              <form onSubmit={handleSubmit} className="p-4">
                <Input
                  handleInputChange={handleInputChange}
                  input={input}
                  isInitializing={isInitializing}
                  isLoading={isLoading}
                  status={status}
                  stop={stop}
                />
              </form>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            defaultSize={62}
            minSize={40}
            className="flex flex-col bg-zinc-950"
          >
            <ResizablePanelGroup direction="vertical" className="h-full">
              <ResizablePanel defaultSize={65} minSize={35}>
                <div className="h-full relative">
                  <VncViewer
                    streamUrl={streamUrl}
                    isInitializing={isInitializing}
                    onRefresh={refreshDesktop}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={35}
                minSize={20}
                className="border-t border-zinc-800 bg-zinc-900 p-4 text-zinc-100 flex flex-col min-h-0"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold">Tool call details</div>
                  <div className="text-xs text-zinc-400">
                    {events.length} total
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto pr-1">
                  {events.length === 0 ? (
                    <div className="text-sm text-zinc-400">
                      No tool calls captured yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {events.slice(-30).map((event) => (
                        <details
                          key={event.id}
                          className="rounded-md border border-zinc-800 bg-zinc-950"
                          open={expandedEventId === event.id}
                        >
                          <summary
                            className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm"
                            onClick={(evt) => {
                              evt.preventDefault();
                              setExpandedEventId((current) =>
                                current === event.id ? null : event.id,
                              );
                            }}
                          >
                            <div>
                              <div className="font-medium">
                                {getEventType(event)}
                              </div>
                              <div className="text-xs text-zinc-400">
                                {formatTimestamp(event.timestamp)} · {event.id}
                              </div>
                            </div>
                            <div className="text-right">
                              <div
                                className={cn(
                                  "text-xs font-semibold",
                                  getStatusTone(event.status),
                                )}
                              >
                                {event.status}
                              </div>
                              <div className="text-xs text-zinc-400">
                                {formatDuration(event.durationMs)}
                              </div>
                            </div>
                          </summary>
                          <div className="border-t border-zinc-800 px-3 py-3">
                            {renderEventDetails(event)}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <div className="w-full lg:hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-zinc-200">
          <div className="flex items-center gap-3">
            <AISDKLogo />
            <span className="text-xs text-zinc-500">{agentStatus}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={mobileView === "chat" ? "default" : "secondary"}
              onClick={() => setMobileView("chat")}
            >
              Chat
            </Button>
            <Button
              size="sm"
              variant={mobileView === "desktop" ? "default" : "secondary"}
              onClick={() => setMobileView("desktop")}
            >
              Desktop
            </Button>
          </div>
        </div>

        {mobileView === "chat" ? (
          <>
            <div className="border-b border-zinc-200 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wide text-zinc-500">
                  Sessions
                </div>
                <Button size="sm" variant="secondary" onClick={createSession}>
                  <Plus className="h-4 w-4" />
                  New
                </Button>
              </div>
              <div className="mt-2 flex flex-col gap-2 max-h-32 overflow-y-auto">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
                      session.id === activeSessionId
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white",
                    )}
                  >
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => setActiveSessionId(session.id)}
                    >
                      <div className="font-medium line-clamp-1">
                        {session.title}
                      </div>
                      <div
                        className={cn(
                          "text-xs",
                          session.id === activeSessionId
                            ? "text-zinc-200"
                            : "text-zinc-500",
                        )}
                      >
                        Updated {formatTimestamp(session.updatedAt)}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "ml-2",
                        session.id === activeSessionId
                          ? "text-white hover:bg-white/10"
                          : "text-zinc-500",
                      )}
                      onClick={() => deleteSession(session.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="flex-1 space-y-6 py-4 overflow-y-auto px-4 bg-white"
              ref={desktopContainerRef}
            >
              {messages.length === 0 ? <ProjectInfo /> : null}
              {messages.map((message, i) => (
                <PreviewMessage
                  message={message}
                  key={message.id}
                  isLoading={isLoading}
                  status={status}
                  isLatestMessage={i === messages.length - 1}
                />
              ))}
              <div ref={desktopEndRef} className="pb-2" />
            </div>

            {messages.length === 0 && (
              <PromptSuggestions
                disabled={isInitializing}
                submitPrompt={(prompt: string) =>
                  append({ role: "user", content: prompt })
                }
              />
            )}

            <div className="border-t border-zinc-200 bg-white">
              <form onSubmit={handleSubmit} className="p-4">
                <Input
                  handleInputChange={handleInputChange}
                  input={input}
                  isInitializing={isInitializing}
                  isLoading={isLoading}
                  status={status}
                  stop={stop}
                />
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 bg-black">
            <VncViewer
              streamUrl={streamUrl}
              isInitializing={isInitializing}
              onRefresh={refreshDesktop}
            />
          </div>
        )}
      </div>
    </div>
  );
}
