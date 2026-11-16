import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, Check, Sparkles, Waypoints } from "lucide-react";
import { LESSONS, bySlug, cached, load, readMinutes } from "../course";
import { EXTRAS } from "../extras";
import { sections, type Heading } from "../lib/parse";
import { useDone, useTasks } from "../progress";
import { useChat, useChatSource } from "../chat/store";
import { Markdown, scrollToId } from "../components/Markdown";
import { Relate } from "../components/Relate";
import { Flow, SceneView } from "../components/Scene";

export function Lesson() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const route = useLocation().pathname;
  const at = params.get("at");
  const entry = bySlug.get(slug);
  const [data, setData] = useState(() => cached(slug));
  const [done, setDone] = useDone();
  const [ticks, toggleTask] = useTasks(slug);
  const tasks = useMemo(() => ({ ticks, toggle: toggleTask }), [ticks, toggleTask]);
  const article = useRef<HTMLElement>(null);
  const extra = entry ? EXTRAS[entry.lesson.num] : undefined;

  useEffect(() => {
    if (!entry) return;
    let live = true;
    setData(cached(slug));
    load(slug).then((d) => live && setData(d));
    document.title = `${entry.lesson.title} · Backend from first principles`;
    return () => {
      live = false;
    };
  }, [slug, entry]);

  // New lesson → top of the page, or the section a search result pointed at.
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    if (at) requestAnimationFrame(() => scrollToId(at));
    else window.scrollTo(0, 0);
  }, [slug, at, loaded]);

  // The text cut at its headings, so each animation can sit at the end of the section it explains.
  const parts = useMemo(() => (data ? sections(data.body) : []), [data]);

  useChatSource(
    "lesson",
    entry
      ? {
          label: `Lesson ${entry.lesson.num} · ${entry.lesson.title}`,
          suggestions: [
            `Explain ${entry.lesson.title.toLowerCase()} with a different everyday example`,
            "Quiz me on this lesson, one question at a time",
            "What goes wrong in production if I get this wrong?",
            "Give me a hint for this lesson's Linkbox step",
          ],
          build: () => ({
            lesson: `${entry.lesson.num} ${entry.lesson.title}`,
            part: entry.lesson.part,
            summary: entry.lesson.summary,
            everydayComparison: extra?.analogy,
            animations: data?.scenes.map((s) => s.title),
            finished: !!done[slug],
            text: data?.body ?? "(still loading)",
          }),
        }
      : null,
  );

  const explain = useCallback(
    (code: string) => useChat.getState().ask(`Explain this code from the lesson line by line, then say what would break if I changed it:\n\n\`\`\`\n${code.trim()}\n\`\`\``, route),
    [route],
  );

  if (!entry) {
    return (
      <main className="lesson-main lesson-layout">
        <div>
          <h1>Not found</h1>
          <p>
            There is no lesson called “{slug}”. <Link to="/">See all lessons</Link>.
          </p>
        </div>
      </main>
    );
  }

  const { lesson, index } = entry;
  const prev = LESSONS[index - 1];
  const next = LESSONS[index + 1];
  const animations = (extra ? 1 : 0) + (data?.scenes.length ?? 0);
  const toc: Heading[] = [
    ...(extra ? [{ depth: 2 as const, text: "In real life", id: "in-real-life" }, { depth: 2 as const, text: "See it move", id: "see-it-move" }] : []),
    ...lesson.headings.filter((h) => h.depth === 2),
  ];

  return (
    <div className="lesson-layout">
      <main className="lesson-main">
        <article className="lesson" ref={article}>
          <header className="lesson-head">
            <p className="eyebrow">
              {lesson.part} · Lesson {lesson.num}
            </p>
            <h1>{lesson.title}</h1>
            <p className="lesson-summary">{lesson.summary}</p>
            <ul className="lesson-meta">
              <li>
                <BookOpen size={15} />
                {readMinutes(lesson)} min read
              </li>
              {animations > 0 && (
                <li>
                  <Waypoints size={15} />
                  {animations} {animations === 1 ? "animation" : "animations"}
                </li>
              )}
              {done[slug] && (
                <li className="is-done">
                  <Check size={15} />
                  Finished
                </li>
              )}
            </ul>
          </header>

          {!data ? (
            <p className="muted">Loading…</p>
          ) : (
            parts.map((part, n) => (
              <div key={n}>
                <div className={n === 0 && !part.id ? "prose lead" : "prose"}>
                  <Markdown source={part.md} tasks={tasks} taskKey={String(n)} onExplain={explain} />
                </div>
                {n === 0 && extra && (
                  <>
                    <Relate extra={extra} />
                    <div id="see-it-move" className="anchor">
                      <Flow key={slug} data={extra.flow} />
                    </div>
                  </>
                )}
                {data.scenes.filter((s) => s.after === part.id).map((s) => <SceneView key={`${slug}:${s.title}`} scene={s} />)}
              </div>
            ))
          )}

          <label className={`done${done[slug] ? " is-on" : ""}`}>
            <input type="checkbox" checked={!!done[slug]} onChange={(e) => setDone(slug, e.target.checked)} />
            <span className="done-box">
              <Check size={15} strokeWidth={3} />
            </span>
            <span>
              <b>{done[slug] ? "Lesson finished" : "I've finished this lesson"}</b>
              <small>{done[slug] ? "Come back in a week and answer Check yourself again." : "Tick this when you have done the Build step and answered Check yourself."}</small>
            </span>
          </label>

          <nav className="pager" aria-label="Lessons">
            {prev ? (
              <Link to={`/${prev.slug}`}>
                <span>
                  <ArrowLeft size={14} /> Previous
                </span>
                {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link className="next" to={`/${next.slug}`}>
                <span>
                  Next <ArrowRight size={14} />
                </span>
                {next.title}
              </Link>
            )}
          </nav>
        </article>
      </main>
      <Toc items={toc} />
      <SelectionAsk container={article} route={route} />
    </div>
  );
}

/** "On this page", shown beside the lesson on wide screens; highlights the section you're reading. */
function Toc({ items }: { items: Heading[] }) {
  const [active, setActive] = useState<string>();
  const ids = items.map((h) => h.id).join(" ");

  useEffect(() => {
    const onScroll = () => {
      let current: string | undefined;
      for (const id of ids.split(" ")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 140) current = id;
      }
      setActive(current ?? ids.split(" ")[0]);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids]);

  if (items.length < 3) return null;
  return (
    <aside className="toc" aria-label="On this page">
      <p>On this page</p>
      <ol>
        {items.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={active === h.id ? "is-on" : undefined}
              onClick={(e) => {
                e.preventDefault();
                scrollToId(h.id);
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ol>
    </aside>
  );
}

/** Select any text in the lesson and a small "Ask AI" button appears above it. */
function SelectionAsk({ container, route }: { container: RefObject<HTMLElement | null>; route: string }) {
  const [sel, setSel] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const read = () =>
      setTimeout(() => {
        const s = window.getSelection();
        const text = s?.toString().trim() ?? "";
        if (!s || s.rangeCount === 0 || text.length < 3 || text.length > 1500 || !container.current?.contains(s.anchorNode)) return setSel(null);
        const r = s.getRangeAt(0).getBoundingClientRect();
        setSel({ x: Math.min(Math.max(r.left + r.width / 2, 70), window.innerWidth - 70), y: Math.max(r.top, 60), text });
      }, 0);
    const clear = () => setSel(null);
    document.addEventListener("mouseup", read);
    document.addEventListener("touchend", read);
    window.addEventListener("scroll", clear, { passive: true });
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("touchend", read);
      window.removeEventListener("scroll", clear);
    };
  }, [container]);

  if (!sel) return null;
  // Rendered on <body>: the page area is a size container, which would otherwise capture fixed positioning.
  return createPortal(
    <button
      type="button"
      className="sel-ask"
      style={{ left: sel.x, top: sel.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        useChat.getState().ask(`Explain this part of the lesson in simpler words, with an example:\n\n> ${sel.text}`, route);
        window.getSelection()?.removeAllRanges();
        setSel(null);
      }}
    >
      <Sparkles size={14} />
      Ask AI
    </button>,
    document.body,
  );
}
