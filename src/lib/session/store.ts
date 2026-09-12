import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logger";
import {
  extractPreferences,
  mergePreferences,
  type Preference,
} from "@/lib/session/preferences";
import type { ChatMessage } from "@/lib/types";

const log = createLogger("session");

/** Turns kept verbatim in the prompt. Older turns fall out; preferences survive them. */
const MAX_HISTORY_MESSAGES = 12;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;

export interface Session {
  id: string;
  messages: ChatMessage[];
  preferences: Preference[];
  createdAt: number;
  updatedAt: number;
}

/**
 * In-process conversation store.
 *
 * Good enough for a single-node deployment and for the assignment's scope; the
 * interface is narrow on purpose so swapping in Redis is a change to this file
 * only. Sessions expire so a long-lived server does not accumulate transcripts
 * indefinitely.
 */
class SessionStore {
  private sessions = new Map<string, Session>();

  get(id: string | undefined): Session {
    this.evictExpired();

    if (id) {
      const existing = this.sessions.get(id);
      if (existing) return existing;
    }

    const session: Session = {
      id: id ?? randomUUID(),
      messages: [],
      preferences: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /** Records a user turn and folds any preferences it states into the session. */
  appendUserMessage(session: Session, content: string): Preference[] {
    session.messages.push({ role: "user", content });
    const discovered = extractPreferences(content);

    if (discovered.length > 0) {
      const before = new Set(session.preferences.map((p) => `${p.key}=${p.value}`));
      session.preferences = mergePreferences(session.preferences, discovered);
      const added = session.preferences.filter((p) => !before.has(`${p.key}=${p.value}`));
      if (added.length > 0) {
        log.debug(`Session ${short(session.id)} learned: ${added.map((p) => p.value).join("; ")}`);
      }
    }

    this.trim(session);
    return session.preferences;
  }

  appendAssistantMessage(session: Session, content: string): void {
    session.messages.push({ role: "assistant", content });
    this.trim(session);
  }

  reset(id: string): void {
    this.sessions.delete(id);
  }

  private trim(session: Session): void {
    session.updatedAt = Date.now();
    if (session.messages.length > MAX_HISTORY_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_HISTORY_MESSAGES);
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }

    // Belt and braces against a burst of one-shot sessions.
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, this.sessions.size - MAX_SESSIONS);
      for (const session of oldest) this.sessions.delete(session.id);
    }
  }
}

const globalForSessions = globalThis as typeof globalThis & { __sessionStore?: SessionStore };

export const sessionStore: SessionStore = (globalForSessions.__sessionStore ??= new SessionStore());

function short(id: string): string {
  return id.slice(0, 8);
}
