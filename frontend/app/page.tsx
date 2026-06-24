"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import React from "react";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type Role = "user" | "assistant";

interface ChatMessage {
  role: Role;
  content: string;
  imageUrl?: string;
}

interface ChatSession {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  messages: ChatMessage[];
}

type Status = "idle" | "loading" | "streaming" | "error";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const STORAGE_KEY = "dsp-copilot-v2";

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function newSession(): ChatSession {
  return {
    id: makeId(),
    title: "New Chat",
    pinned: false,
    createdAt: Date.now(),
    messages: [],
  };
}

function persist(sessions: ChatSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // quota exceeded — silently skip
  }
}

function load(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ChatSession[];
  } catch {
    /* ignore */
  }
  return [];
}

// ─────────────────────────────────────────────
// MARKDOWN COMPONENTS
// ─────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={copy}
      className="
        absolute top-3 right-3
        text-xs px-3 py-1 rounded-lg
        bg-white/10 hover:bg-white/20
        border border-white/15
        text-gray-300 hover:text-white
        transition-all duration-200
        font-mono
      "
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const markdownComponents: Record<string, React.ComponentType<any>> = {
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const code  = String(children).replace(/\n$/, "");

    if (match) {
      return (
        <div className="relative my-4 rounded-2xl overflow-hidden border border-white/10">
          <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
            <span className="text-xs font-mono text-cyan-400 uppercase tracking-widest">
              {match[1]}
            </span>
            <CopyButton text={code} />
          </div>
          <SyntaxHighlighter
            language={match[1]}
            style={oneDark}
            customStyle={{
              margin: 0,
              background: "transparent",
              padding: "1rem",
              fontSize: "0.85rem",
            }}
          >
            {code}
          </SyntaxHighlighter>
        </div>
      );
    }

    return (
      <code
        className="
          bg-cyan-500/15 text-cyan-300
          rounded px-1.5 py-0.5
          font-mono text-sm border border-cyan-500/20
        "
      >
        {children}
      </code>
    );
  },

  h1: ({ children }) => (
    <h1 className="text-2xl font-bold text-white mt-6 mb-3 border-b border-white/10 pb-2">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-semibold text-white mt-5 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-semibold text-cyan-300 mt-4 mb-1">{children}</h3>
  ),
  p:  ({ children }) => (
    <p className="text-gray-200 leading-7 mb-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-none space-y-1 mb-3 pl-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 space-y-1 mb-3 text-gray-200">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="flex gap-2 text-gray-200 before:content-['▸'] before:text-cyan-400 before:flex-shrink-0">
      <span>{children}</span>
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-cyan-500 pl-4 my-4 text-gray-400 italic bg-cyan-500/5 py-2 pr-2 rounded-r-xl">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border border-white/10 rounded-xl overflow-hidden">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-white/10 px-4 py-2 text-left font-semibold text-cyan-300 border-b border-white/10">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 border-b border-white/5 text-gray-300">{children}</td>
  ),
  strong: ({ children }) => (
    <strong className="text-white font-semibold">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="text-cyan-200 italic">{children}</em>
  ),
  hr: () => <hr className="border-white/10 my-5" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-cyan-400 underline underline-offset-4 hover:text-cyan-300 transition"
    >
      {children}
    </a>
  ),
};

// ─────────────────────────────────────────────
// MESSAGE BUBBLE
// ─────────────────────────────────────────────

function MessageBubble({
  msg,
  isLast,
  streaming,
}: {
  msg: ChatMessage;
  isLast: boolean;
  streaming: boolean;
}) {
  const isUser = msg.role === "user";
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"} max-w-3xl w-full`}>
        {/* Avatar label */}
        <span className="text-xs text-gray-500 px-2 font-mono tracking-widest uppercase">
          {isUser ? "You" : "DSP Copilot"}
        </span>

        {/* Bubble */}
        <div
          className={`
            rounded-3xl px-7 py-5 shadow-2xl
            ${isUser
              ? "bg-gradient-to-br from-blue-600 to-cyan-500 text-white rounded-br-lg"
              : "bg-white/[0.04] border border-white/10 text-gray-100 rounded-bl-lg backdrop-blur-xl"
            }
          `}
        >
          {msg.imageUrl && (
            <img
              src={msg.imageUrl}
              alt="Uploaded"
              className="rounded-2xl mb-4 max-h-60 object-cover"
            />
          )}

          {isUser ? (
            <p className="text-[15px] leading-7 whitespace-pre-wrap">{msg.content}</p>
          ) : (
            <div className="prose prose-invert max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={markdownComponents}
              >
                {msg.content}
              </ReactMarkdown>
              {isLast && streaming && (
                <span className="inline-block w-2 h-4 bg-cyan-400 animate-pulse rounded-sm ml-0.5" />
              )}
            </div>
          )}
        </div>

        {/* Copy button for assistant */}
        {!isUser && !streaming && (
          <button
            onClick={copy}
            className="
              opacity-0 group-hover:opacity-100
              text-xs text-gray-500 hover:text-gray-300
              bg-white/5 hover:bg-white/10
              border border-white/10
              px-3 py-1.5 rounded-xl
              transition-all duration-200
              font-mono
            "
          >
            {copied ? "✓ Copied" : "Copy response"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────

function EmptyState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const suggestions = [
    "Explain the DFT and its relationship to the DTFT",
    "Derive the transfer function of a 2nd-order IIR low-pass filter",
    "What is the Nyquist theorem and why does aliasing occur?",
    "Write MATLAB code for a Butterworth filter design",
    "Explain convolution in DSP with an intuitive example",
    "What is the difference between FIR and IIR filters?",
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-10 px-4">
      {/* Oscilloscope signature */}
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-24 h-24">
          <svg viewBox="0 0 96 96" className="w-full h-full">
            <defs>
              <linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#06b6d4" />
              </linearGradient>
            </defs>
            {/* Screen bezel */}
            <rect x="4" y="4" width="88" height="88" rx="12" fill="none" stroke="url(#waveGrad)" strokeWidth="2" opacity="0.4" />
            {/* Sine wave */}
            <path
              d="M10 48 Q22 20 34 48 Q46 76 58 48 Q70 20 82 48"
              fill="none"
              stroke="url(#waveGrad)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            {/* Grid lines */}
            <line x1="10" y1="48" x2="86" y2="48" stroke="white" strokeWidth="0.5" opacity="0.15" />
            <line x1="48" y1="10" x2="48" y2="86" stroke="white" strokeWidth="0.5" opacity="0.15" />
          </svg>
          {/* Pulse dot */}
          <div className="absolute top-1/2 right-3 -translate-y-1/2 w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
        </div>

        <div className="text-center">
          <h2 className="text-3xl font-black tracking-tight bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
            DSP Copilot
          </h2>
          <p className="text-gray-500 mt-1 text-sm">
            Your AI workspace for Signal Processing & Engineering
          </p>
        </div>
      </div>

      {/* Suggestions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-2xl">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestion(s)}
            className="
              text-left text-sm text-gray-400 hover:text-white
              bg-white/[0.03] hover:bg-white/[0.07]
              border border-white/8 hover:border-cyan-500/40
              rounded-2xl px-5 py-4
              transition-all duration-200
              leading-relaxed
            "
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CIRCUIT PANEL
// ─────────────────────────────────────────────

function CircuitPanel({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="flex items-center justify-between w-full max-w-2xl px-2">
        <span className="text-sm font-mono text-cyan-400 tracking-widest uppercase">
          Generated Circuit
        </span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white transition text-xs bg-white/5 px-3 py-1.5 rounded-lg border border-white/10"
        >
          Dismiss
        </button>
      </div>
      <img
        src={url}
        alt="Generated Circuit Diagram"
        className="bg-white rounded-3xl p-5 max-w-2xl w-full shadow-2xl border-4 border-white/10"
      />
      <a
        href={url}
        download="circuit.png"
        className="text-xs text-gray-500 hover:text-cyan-400 transition font-mono underline underline-offset-4"
      >
        Download PNG
      </a>
    </div>
  );
}

// ─────────────────────────────────────────────
// SIDEBAR ITEM
// ─────────────────────────────────────────────

function SidebarItem({
  session,
  active,
  onSelect,
  onPin,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onPin: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`
        group relative rounded-2xl p-3.5 cursor-pointer transition-all duration-200
        border
        ${active
          ? "bg-gradient-to-r from-white/10 to-white/5 border-cyan-500/50 shadow-lg shadow-cyan-500/10"
          : "bg-white/[0.025] border-white/5 hover:bg-white/[0.05] hover:border-white/10"
        }
      `}
    >
      <div className="flex items-center gap-2">
        {session.pinned && (
          <span className="text-cyan-400 text-xs flex-shrink-0">📌</span>
        )}
        <span className="truncate text-[14px] text-gray-300 font-medium flex-1">
          {session.title}
        </span>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition flex-shrink-0">
          <button
            onClick={onPin}
            title={session.pinned ? "Unpin" : "Pin"}
            className="p-1 rounded-lg hover:bg-white/10 text-gray-500 hover:text-cyan-400 transition text-sm"
          >
            📌
          </button>
          <button
            onClick={onDelete}
            title="Delete chat"
            className="p-1 rounded-lg hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition text-sm"
          >
            🗑
          </button>
        </div>
      </div>
      <span className="text-[11px] text-gray-600 mt-0.5 block pl-0.5">
        {session.messages.length === 0
          ? "Empty"
          : `${session.messages.length} messages`}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────

export default function Home() {
  // ── State ────────────────────────────────
  const [sessions, setSessions]       = useState<ChatSession[]>([]);
  const [activeId, setActiveId]       = useState<string>("");
  const [prompt, setPrompt]           = useState("");
  const [status, setStatus]           = useState<Status>("idle");
  const [errorMsg, setErrorMsg]       = useState("");
  const [search, setSearch]           = useState("");
  const [circuitUrl, setCircuitUrl]   = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dragOver, setDragOver]       = useState(false);
  const [pendingImage, setPendingImage] = useState<{ url: string; file: File } | null>(null);

  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const bottomRef      = useRef<HTMLDivElement>(null);
  const abortRef       = useRef<AbortController | null>(null);
  const streamBufferRef = useRef("");

  // ── Boot ─────────────────────────────────
  useEffect(() => {
    const saved = load();
    if (saved.length > 0) {
      setSessions(saved);
      setActiveId(saved[0].id);
    } else {
      const s = newSession();
      setSessions([s]);
      setActiveId(s.id);
    }
  }, []);

  // ── Persist ──────────────────────────────
  useEffect(() => {
    if (sessions.length > 0) persist(sessions);
  }, [sessions]);

  // ── Auto-scroll ──────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessions, status]);

  // ── Auto-resize textarea ─────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [prompt]);

  // ── Derived ──────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeId);
  const messages      = activeSession?.messages ?? [];
  const isStreaming   = status === "streaming";
  const isLoading     = status === "loading" || status === "streaming";

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  // sorted: pinned first, then by creation date desc
  const sortedSessions = [...filteredSessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  // ── Session management ───────────────────
  const createSession = useCallback(() => {
    const existing = sessions.find((s) => s.messages.length === 0);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setCircuitUrl(null);
  }, [sessions]);

  const deleteSession = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setSessions((prev) => {
        const updated = prev.filter((s) => s.id !== id);
        if (id === activeId && updated.length > 0) setActiveId(updated[0].id);
        return updated;
      });
    },
    [activeId]
  );

  const pinSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s))
    );
  }, []);

  // ── Update session messages ───────────────
  const patchMessages = useCallback(
    (id: string, msgs: ChatMessage[]) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          return {
            ...s,
            title:
              s.messages.length === 0 && msgs.length > 0
                ? msgs[0].content.slice(0, 48)
                : s.title,
            messages: msgs,
          };
        })
      );
    },
    []
  );

  // ── Streaming chat ────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || isLoading || !activeSession) return;

    setStatus("loading");
    setErrorMsg("");
    setCircuitUrl(null);

    const userMsg: ChatMessage = {
      role: "user",
      content: prompt,
      imageUrl: pendingImage?.url,
    };

    const history = [...messages, userMsg];
    patchMessages(activeId, history);
    setPrompt("");
    setPendingImage(null);

    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    const withPlaceholder = [...history, assistantMsg];
    patchMessages(activeId, withPlaceholder);

    abortRef.current = new AbortController();

    try {
      // Try streaming first
      const res = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: userMsg.content,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) throw new Error("stream unavailable");

      setStatus("streaming");
      streamBufferRef.current = "";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Batch React state updates — only re-render every ~50ms instead of
      // on every token. This prevents React from thrashing the DOM at
      // 5-8 token/sec which paradoxically makes streaming feel SLOWER.
      let rafId: ReturnType<typeof setTimeout> | null = null;
      const flushToUI = () => {
        const content = streamBufferRef.current;
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeId) return s;
            const updated = [...s.messages];
            updated[updated.length - 1] = { role: "assistant", content };
            return { ...s, messages: updated };
          })
        );
      };
      const scheduleFlush = () => {
        if (rafId !== null) return;
        rafId = setTimeout(() => { rafId = null; flushToUI(); }, 50);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const raw = decoder.decode(value, { stream: true });
        const lines = raw.split("\n");
        let finished = false;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const token = line.slice(6);
          if (token === "[DONE]") { finished = true; break; }
          streamBufferRef.current += token.replace(/\\n/g, "\n");
          scheduleFlush();
        }

        if (finished) { reader.cancel(); break; }
      }

      // Final flush to ensure last tokens are shown
      if (rafId !== null) clearTimeout(rafId);
      flushToUI();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setStatus("idle");
        return;
      }

      // Fallback to non-streaming
      try {
        const res2 = await fetch(`${API}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: userMsg.content,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const data = await res2.json() as { response: string };

        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeId) return s;
            const updated = [...s.messages];
            updated[updated.length - 1] = {
              role: "assistant",
              content: data.response ?? "No response.",
            };
            return { ...s, messages: updated };
          })
        );
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : "Unknown error";
        setErrorMsg(`Backend error: ${msg}. Is the server running on ${API}?`);
        setStatus("error");
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeId) return s;
            return { ...s, messages: s.messages.slice(0, -1) };
          })
        );
        return;
      }
    }

    setStatus("idle");
  }, [prompt, isLoading, activeSession, messages, patchMessages, activeId, pendingImage]);

  // ── Circuit generation ────────────────────
  const handleGenerateCircuit = useCallback(async () => {
    if (!prompt.trim() || isLoading) return;
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch(`${API}/generate-circuit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      setCircuitUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setErrorMsg(`Circuit error: ${msg}`);
    } finally {
      setStatus("idle");
    }
  }, [prompt, isLoading]);

  // ── Image upload / drag-drop ──────────────
  const handleImageFile = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const res  = await fetch(`${API}/upload-image`, { method: "POST", body: form });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json() as { url: string };
      setPendingImage({ url: `${API}${data.url}`, file });
    } catch {
      setPendingImage({ url: URL.createObjectURL(file), file });
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file?.type.startsWith("image/")) void handleImageFile(file);
    },
    [handleImageFile]
  );

  // ── Keyboard shortcuts ────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  // ── Stop streaming ────────────────────────
  const handleStop = () => {
    abortRef.current?.abort();
    setStatus("idle");
  };

  // ─────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────

  return (
    <>
      {/* KaTeX CSS */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"
      />

      <main className="flex h-screen bg-[#030508] text-white overflow-hidden">

        {/* ── SIDEBAR ─────────────────────────── */}
        <aside
          className={`
            ${sidebarOpen ? "w-[300px]" : "w-0"}
            flex-shrink-0 transition-all duration-300 overflow-hidden
            border-r border-white/[0.06]
            bg-[#060810]
            flex flex-col
          `}
        >
          <div className="p-4 space-y-3 min-w-[300px]">
            {/* Logo */}
            <div className="flex items-center gap-2 px-1 py-2">
              <svg viewBox="0 0 32 32" className="w-7 h-7 flex-shrink-0">
                <defs>
                  <linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#06b6d4" />
                  </linearGradient>
                </defs>
                <rect x="1" y="1" width="30" height="30" rx="6" fill="none" stroke="url(#lg)" strokeWidth="1.5" opacity="0.5" />
                <path d="M4 16 Q9 6 14 16 Q19 26 24 16 Q27 10 30 16" fill="none" stroke="url(#lg)" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="font-black text-lg tracking-tight bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
                DSP Copilot
              </span>
            </div>

            {/* New Chat */}
            <button
              onClick={createSession}
              className="
                w-full rounded-2xl py-3 px-4 font-semibold text-sm
                bg-gradient-to-r from-blue-600 to-cyan-500
                hover:from-blue-500 hover:to-cyan-400
                hover:scale-[1.02] active:scale-[0.98]
                transition-all duration-200 shadow-lg shadow-blue-500/20
              "
            >
              + New Chat
            </button>

            {/* Search */}
            <div className="relative">
              <input
                placeholder="Search chats…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="
                  w-full bg-white/[0.04] border border-white/8
                  rounded-xl px-4 py-2.5 text-sm outline-none
                  placeholder:text-gray-600
                  focus:border-cyan-500/40 transition
                "
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1.5 min-w-[300px]">
            {sortedSessions.length === 0 ? (
              <p className="text-center text-gray-600 text-sm py-8">No chats found</p>
            ) : (
              sortedSessions.map((s) => (
                <SidebarItem
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onSelect={() => { setActiveId(s.id); setCircuitUrl(null); setErrorMsg(""); }}
                  onPin={(e) => pinSession(s.id, e)}
                  onDelete={(e) => deleteSession(s.id, e)}
                />
              ))
            )}
          </div>
        </aside>

        {/* ── MAIN ────────────────────────────── */}
        <section className="flex-1 flex flex-col min-w-0 bg-gradient-to-b from-[#04060f] to-[#030508]">

          {/* Header */}
          <header className="
            flex-shrink-0 h-16
            border-b border-white/[0.06]
            px-5 flex items-center justify-between
            backdrop-blur-xl bg-black/20
          ">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="p-2 rounded-xl hover:bg-white/8 text-gray-500 hover:text-white transition"
              title="Toggle sidebar"
            >
              ☰
            </button>

            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-sm text-gray-500 font-mono">llama-3.3-70b · groq</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 font-mono">
                {messages.length > 0 ? `${messages.length} msgs` : ""}
              </span>
            </div>
          </header>

          {/* Messages */}
          <div
            className="flex-1 overflow-y-auto px-4 md:px-10 py-8 space-y-8"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {dragOver && (
              <div className="
                fixed inset-0 z-50 flex items-center justify-center
                bg-cyan-500/10 border-2 border-cyan-500 border-dashed
                backdrop-blur-sm pointer-events-none
              ">
                <p className="text-cyan-400 text-2xl font-bold">Drop image to attach</p>
              </div>
            )}

            {messages.length === 0 && !circuitUrl ? (
              <EmptyState onSuggestion={(s) => { setPrompt(s); textareaRef.current?.focus(); }} />
            ) : (
              <>
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={i}
                    msg={msg}
                    isLast={i === messages.length - 1}
                    streaming={isStreaming && i === messages.length - 1}
                  />
                ))}

                {/* Loading dots */}
                {status === "loading" && (
                  <div className="flex justify-start">
                    <div className="bg-white/[0.04] border border-white/10 rounded-3xl px-6 py-5">
                      <div className="flex gap-2 items-center">
                        <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:0ms]" />
                        <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:150ms]" />
                        <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:300ms]" />
                        <span className="text-xs text-gray-600 ml-2 font-mono">Thinking…</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Error */}
            {errorMsg && (
              <div className="flex justify-center">
                <div className="
                  bg-red-500/10 border border-red-500/30
                  rounded-2xl px-6 py-4 text-red-400 text-sm max-w-xl text-center
                ">
                  {errorMsg}
                </div>
              </div>
            )}

            {/* Circuit */}
            {circuitUrl && (
              <CircuitPanel url={circuitUrl} onClose={() => setCircuitUrl(null)} />
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          <div className="flex-shrink-0 border-t border-white/[0.06] bg-black/30 backdrop-blur-2xl p-4 md:p-5">
            {/* Pending image preview */}
            {pendingImage && (
              <div className="mb-3 flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                <img
                  src={pendingImage.url}
                  alt="Pending"
                  className="w-12 h-12 rounded-xl object-cover"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300 truncate">{pendingImage.file.name}</p>
                  <p className="text-xs text-gray-600">Image attached</p>
                </div>
                <button
                  onClick={() => setPendingImage(null)}
                  className="text-gray-500 hover:text-red-400 transition text-lg leading-none"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="max-w-4xl mx-auto flex gap-3 items-end">
              {/* Image attach button */}
              <label
                title="Attach image"
                className="
                  flex-shrink-0 p-3 rounded-2xl
                  bg-white/[0.04] hover:bg-white/[0.08]
                  border border-white/8 hover:border-white/15
                  text-gray-500 hover:text-white
                  transition cursor-pointer text-lg leading-none
                "
              >
                📎
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleImageFile(f);
                  }}
                />
              </label>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                placeholder="Ask about DSP, FFT, filters, MATLAB, LabVIEW… (Enter to send, Shift+Enter for newline)"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                className="
                  flex-1 bg-white/[0.04] border border-white/8
                  rounded-3xl px-6 py-4
                  outline-none resize-none
                  text-[15px] leading-relaxed
                  placeholder:text-gray-600
                  focus:border-cyan-500/40 focus:bg-white/[0.06]
                  transition-all duration-200
                  max-h-[200px] overflow-y-auto
                "
              />

              {/* Action buttons */}
              <div className="flex flex-col gap-2 flex-shrink-0">
                {isLoading ? (
                  <button
                    onClick={handleStop}
                    className="
                      rounded-2xl px-5 py-4 font-semibold text-sm
                      bg-red-600/80 hover:bg-red-600
                      hover:scale-105 active:scale-95
                      transition-all duration-200 shadow-lg
                    "
                  >
                    ⬛ Stop
                  </button>
                ) : (
                  <button
                    onClick={() => void handleSubmit()}
                    disabled={!prompt.trim()}
                    className="
                      rounded-2xl px-5 py-4 font-semibold text-sm
                      bg-gradient-to-r from-blue-600 to-cyan-500
                      hover:from-blue-500 hover:to-cyan-400
                      disabled:opacity-30 disabled:cursor-not-allowed
                      hover:scale-105 active:scale-95
                      transition-all duration-200 shadow-lg shadow-blue-500/20
                    "
                  >
                    Send ↑
                  </button>
                )}

                <button
                  onClick={() => void handleGenerateCircuit()}
                  disabled={!prompt.trim() || isLoading}
                  className="
                    rounded-2xl px-5 py-4 font-semibold text-sm
                    bg-gradient-to-r from-purple-600 to-pink-500
                    hover:from-purple-500 hover:to-pink-400
                    disabled:opacity-30 disabled:cursor-not-allowed
                    hover:scale-105 active:scale-95
                    transition-all duration-200 shadow-lg shadow-purple-500/20
                  "
                  title="Generate circuit diagram from your prompt"
                >
                  ⚡ Circuit
                </button>
              </div>
            </div>

            <p className="text-center text-[11px] text-gray-700 mt-3 font-mono">
              DSP Copilot · Local AI · ChromaDB RAG · Groq llama-3.3-70b
            </p>
          </div>
        </section>
      </main>
    </>
  );
}