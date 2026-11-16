import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LESSONS } from "../course";

type Hit = { slug: string; at?: string; title: string; context: string; score: number };

// Every lesson and every section heading, flattened once.
const ENTRIES: { slug: string; at?: string; title: string; context: string; hay: string }[] = LESSONS.flatMap((l) => [
  { slug: l.slug, title: l.title, context: `${l.num} · ${l.summary}`, hay: `${l.title} ${l.summary} ${l.part}`.toLowerCase() },
  ...l.headings.map((h) => ({
    slug: l.slug,
    at: h.id,
    title: h.text,
    context: `${l.num} · ${l.title}`,
    hay: `${h.text} ${l.title}`.toLowerCase(),
  })),
]);

function search(q: string): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const e of ENTRIES) {
    if (!words.every((w) => e.hay.includes(w))) continue;
    const title = e.title.toLowerCase();
    // Lessons above sections; title matches above context matches.
    const score = (e.at ? 0 : 2) + words.filter((w) => title.includes(w)).length + (title.startsWith(words[0]) ? 1 : 0);
    hits.push({ slug: e.slug, at: e.at, title: e.title, context: e.context, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}

export function Search({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const hits = useMemo(() => search(q), [q]);

  useEffect(() => {
    input.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const go = (h: Hit) => {
    navigate(h.at ? `/${h.slug}?at=${h.at}` : `/${h.slug}`);
    onClose();
  };

  return (
    <div className="search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search" role="dialog" aria-modal="true" aria-label="Search lessons">
        <input
          ref={input}
          type="search"
          placeholder="Search lessons and sections…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && hits[sel]) go(hits[sel]);
          }}
          aria-controls="search-results"
        />
        {q && (
          <ul id="search-results" role="listbox">
            {hits.length === 0 && <li className="muted empty">Nothing matches “{q}”.</li>}
            {hits.map((h, i) => (
              <li key={`${h.slug}#${h.at ?? ""}`} role="option" aria-selected={i === sel}>
                <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                  {h.title}
                  <small>{h.context}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
