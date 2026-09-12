"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ComposerProps {
  onSend: (question: string) => void;
  onStop: () => void;
  busy: boolean;
  destination: string;
}

const MAX_HEIGHT = 180;

export function Composer({ onSend, onStop, busy, destination }: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a cap, then scroll. Resetting to "auto" first
  // is what lets the box shrink again when text is deleted.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const submit = useCallback(() => {
    if (!value.trim() || busy) return;
    onSend(value);
    setValue("");
  }, [busy, onSend, value]);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="visually-hidden" htmlFor="question">
        Ask about {destination}
      </label>
      <textarea
        id="question"
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — the convention every
          // chat UI has trained people to expect.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={`Ask about ${destination} — attractions, transport, a day-by-day plan, the forecast, or your budget in SGD`}
        rows={1}
        disabled={busy}
      />
      {busy ? (
        <button type="button" className="ghost" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" disabled={!value.trim()}>
          Send
        </button>
      )}
    </form>
  );
}
