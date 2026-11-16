import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BookOpen, Check, CircleHelp, Hammer, Lightbulb, Sparkles, TerminalSquare, Waypoints } from "lucide-react";
import { LESSONS, PARTS, readMinutes } from "../course";
import { COURSE_FLOW } from "../extras";
import { useDone } from "../progress";
import { useChat, useChatSource } from "../chat/store";
import { Flow } from "../components/Scene";
import { Ring } from "../components/Sidebar";

const readingHours = Math.round(LESSONS.reduce((s, l) => s + readMinutes(l), 0) / 60);

const BLURBS: Record<string, string> = {
  Orientation: "What a backend is, why it exists, and how to study this course.",
  "The request": "Everything between a byte arriving and your code running.",
  Data: "Storing, caching, searching and processing data in the background.",
  Production: "Keeping a service correct, debuggable and safe once real people use it.",
  Scale: "What changes with more traffic, more data and bigger files.",
  "Engineering practice": "How teams test, document, connect and ship a backend.",
  Finish: "Put Linkbox together and check it against a production checklist.",
};

const METHOD = [
  { icon: Lightbulb, title: "Relate", text: "An everyday comparison, so the idea has somewhere to land." },
  { icon: Waypoints, title: "See it move", text: "Animations beside each idea. Play them, or step through at your own pace." },
  { icon: BookOpen, title: "Understand", text: "The problem first, then the idea, then the tools that package it." },
  { icon: TerminalSquare, title: "Try it", text: "Commands to run and things to break on purpose." },
  { icon: Hammer, title: "Build", text: "One more step of Linkbox, a bookmarks API you grow all course." },
  { icon: CircleHelp, title: "Check", text: "Questions with hidden answers. The tutor can quiz you further." },
];

export function Home() {
  const [done] = useDone();
  const count = LESSONS.filter((l) => done[l.slug]).length;
  const next = LESSONS.find((l) => !done[l.slug]) ?? LESSONS[0];

  useEffect(() => {
    document.title = "Backend from first principles";
    window.scrollTo(0, 0);
  }, []);

  useChatSource("course", {
    label: "Course overview",
    suggestions: ["What will I be able to build after this course?", "I already know HTTP and SQL. Where should I start?", "Plan my first two weeks at 6 hours a week"],
    build: () => ({
      outline: PARTS.map((p) => ({ part: p.title, lessons: p.lessons.map((l) => `${l.num} ${l.title}: ${l.summary}`) })),
      finished: LESSONS.filter((l) => done[l.slug]).map((l) => l.num),
      hoursOfReading: readingHours,
    }),
  });

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">
            {LESSONS.length} lessons · animated throughout · about {readingHours} hours of reading
          </p>
          <h1>
            Backend, from <em>first principles</em>
          </h1>
          <p className="lede">
            Learn how servers actually work, starting from the problem each idea solves. You begin with one HTTP request and finish with a service you could
            run in production.
          </p>
          <div className="hero-actions">
            <Link className="btn is-primary is-large" to={`/${next.slug}`}>
              {count ? `Continue: ${next.title}` : "Start the course"}
              <ArrowRight size={17} />
            </Link>
            <button type="button" className="btn is-large" onClick={() => useChat.getState().setOpen(true)}>
              <Sparkles size={16} />
              Ask the tutor
            </button>
          </div>
          <div className="hero-progress">
            <Ring value={count} total={LESSONS.length} size={52} />
            <p>
              <b>
                {count} of {LESSONS.length} lessons finished
              </b>
              <span>{count ? `Next up: lesson ${next.num}, ${next.title}.` : "Tick a lesson when you finish it and your progress shows here."}</span>
            </p>
          </div>
        </div>
        <Flow data={COURSE_FLOW} heading="The whole course in one request" />
      </section>

      <section className="method" aria-labelledby="method-title">
        <p className="eyebrow">How every lesson works</p>
        <h2 id="method-title">Six steps, the same every time</h2>
        <ol>
          {METHOD.map(({ icon: Icon, title, text }, i) => (
            <li key={title}>
              <span className="method-icon">
                <Icon size={18} />
              </span>
              <b>
                <i>{i + 1}</i>
                {title}
              </b>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="path" aria-labelledby="path-title">
        <p className="eyebrow">The path</p>
        <h2 id="path-title">Part by part, in order</h2>
        <div className="parts">
          {PARTS.map((part, n) => {
            const finished = part.lessons.filter((l) => done[l.slug]).length;
            return (
              <article className="part" key={part.title}>
                <header>
                  <span className="part-n">{n}</span>
                  <div>
                    <h3>{part.title}</h3>
                    <p>{BLURBS[part.title]}</p>
                  </div>
                  <span className="part-count">
                    {finished}/{part.lessons.length}
                  </span>
                </header>
                <span className="meter" aria-hidden="true">
                  <span style={{ width: `${(finished / part.lessons.length) * 100}%` }} />
                </span>
                <ol>
                  {part.lessons.map((l) => {
                    return (
                      <li key={l.slug}>
                        <Link to={`/${l.slug}`} className={done[l.slug] ? "is-done" : undefined}>
                          <span className="tick">{done[l.slug] ? <Check size={12} strokeWidth={3} /> : l.num}</span>
                          <span className="t">
                            {l.title}
                            <small>{l.summary}</small>
                          </span>
                          <span className="len">{readMinutes(l)} min</span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
