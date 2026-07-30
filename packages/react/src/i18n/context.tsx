import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { koKR } from "./koKR";
import type { DeepPartial, WorkspaceMessages } from "./types";

// 077 — the injection seam. `HwpWorkspace` merges the host's partial catalog over `koKR` ONCE and
// publishes the result on this context; every component reads it with `useWorkspaceMessages()`.
//
// NO PROP-DRILLING (issue 077 결정): strings would otherwise have to thread through a dozen presentational
// components that are also exported individually. The context DEFAULT is `koKR`, so a component mounted
// standalone (no provider anywhere) still renders Korean — the SDK's documented behaviour.
//
// RENDER DISCIPLINE (성능 규율: 제스처 중 리렌더 0): the merged value is memoized on the `messages`
// REFERENCE, so a host passing a stable object never invalidates it — a drag/hover/zoom gesture cannot
// publish a new context value.

/** True for a mergeable plain object — arrays and function messages are LEAVES (replaced wholesale). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge a host's partial catalog over the defaults. Never mutates either input; a subtree the host
 *  did not mention is reused BY REFERENCE (so `merge(koKR, undefined) === koKR`). */
export function mergeMessages(base: WorkspaceMessages, overrides?: DeepPartial<WorkspaceMessages>): WorkspaceMessages {
  if (!overrides) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined) continue; // an explicitly-undefined key means "keep the default"
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? mergeMessages(current as never, value as never) : value;
  }
  return out as unknown as WorkspaceMessages;
}

/** The live catalog. Defaults to `koKR` so provider-less components stay Korean. */
export const WorkspaceMessagesContext = createContext<WorkspaceMessages>(koKR);

/** Read the resolved catalog (defaults + any host override). */
export function useWorkspaceMessages(): WorkspaceMessages {
  return useContext(WorkspaceMessagesContext);
}

/** Merge a host's partial catalog over `koKR`, memoized on the override REFERENCE. Used by
 *  `HwpWorkspace` (which both consumes the result and publishes it) and by `WorkspaceMessagesProvider`. */
export function useMergedMessages(overrides?: DeepPartial<WorkspaceMessages>): WorkspaceMessages {
  return useMemo(() => mergeMessages(koKR, overrides), [overrides]);
}

export interface WorkspaceMessagesProviderProps {
  /** Partial override; anything omitted falls back to `koKR`. */
  messages?: DeepPartial<WorkspaceMessages>;
  children: ReactNode;
}

/** Publish a catalog to a subtree. Only needed when components are mounted OUTSIDE `HwpWorkspace`
 *  (a standalone `ChatPanel`, a host-composed toolbar) — `HwpWorkspace` provides its own. */
export function WorkspaceMessagesProvider({ messages, children }: WorkspaceMessagesProviderProps) {
  const value = useMergedMessages(messages);
  return createElement(WorkspaceMessagesContext.Provider, { value }, children);
}
