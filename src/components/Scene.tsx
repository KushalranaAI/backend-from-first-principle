import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import type { BoxesData, FlowData, Kind, Scene } from "../extras";

const STEP_MS = 2800;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Caption = { who?: ReactNode; label: string; note: string; kind: Kind; link?: string };

/**
 * The frame every animation shares: a title, transport controls, a stage, a caption that says what just happened,
 * and one button per step. It plays once when scrolled into view. Every step is also reachable with the controls,
 * so nothing depends on watching it move.
 */
function Player(props: {
  title: string;
  heading: string;
  count: number;
  stage: (i: number) => ReactNode;
  caption: (i: number) => Caption;
}) {
  const { count: n } = props;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLElement>(null);
  const cap = props.caption(i);

  // Start by itself the first time it is on screen.
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPlaying(true);
          io.disconnect();
        }
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (i >= n - 1) return setPlaying(false);
    const t = setTimeout(() => setI(i + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, i, n]);

  const go = (k: number) => {
    setPlaying(false);
    setI(Math.max(0, Math.min(n - 1, k)));
  };

  return (
    <section className="flow" ref={root} aria-label={props.title}>
      <header className="flow-head">
        <div>
          <p className="eyebrow">{props.heading}</p>
          <h3>{props.title}</h3>
        </div>
        <div className="flow-controls">
          <button type="button" className="icon-btn" onClick={() => go(0)} aria-label="Restart" title="Restart">
            <RotateCcw size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous step" title="Previous step">
            <SkipBack size={16} />
          </button>
          <button
            type="button"
            className="icon-btn is-primary"
            onClick={() => {
              if (!playing && i >= n - 1) setI(0);
              setPlaying(!playing);
            }}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className="icon-btn" onClick={() => go(i + 1)} disabled={i === n - 1} aria-label="Next step" title="Next step">
            <SkipForward size={16} />
          </button>
        </div>
      </header>

      {props.stage(i)}

      <div className="flow-caption" key={i} aria-live={playing ? "off" : "polite"}>
        <p className={`flow-label is-${cap.kind}`}>
          {cap.who && <span className="flow-who">{cap.who}</span>}
          <code>{cap.label}</code>
        </p>
        {cap.note && <p className="flow-note">{cap.note}</p>}
        {cap.link && (
          <Link className="flow-link" to={`/${cap.link}`}>
            Open this lesson <ArrowRight size={14} />
          </Link>
        )}
      </div>

      <ol className="flow-steps" aria-label="Steps">
        {Array.from({ length: n }, (_, k) => {
          const label = props.caption(k).label;
          return (
            <li key={k}>
              <button
                type="button"
                className={k === i ? "is-on" : k < i ? "is-done" : undefined}
                aria-current={k === i ? "step" : undefined}
                aria-label={`Step ${k + 1} of ${n}: ${label}`}
                title={label}
                onClick={() => go(k)}
              >
                {k + 1}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Actors along a line, with one message travelling between them per step. */
function FlowStage({ data, i }: { data: FlowData; i: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const [from, to, , , kind = "req"] = data.steps[i];
  const center = (k: number) => ((k + 0.5) / data.actors.length) * 100;
  // Each column is at least as wide as its longest word, so names never break mid-word; narrow screens scroll the stage.
  const longest = Math.max(...data.actors.flatMap((a) => a.split(" ").map((w) => w.length)));
  const col = `${(longest * 0.47 + 1.3).toFixed(2)}rem`;

  // On a narrow screen, keep the actor receiving the message in view (scrolls the stage only, never the page).
  useEffect(() => {
    const el = stage.current;
    const li = el?.querySelectorAll("li")[to];
    if (el && li && el.scrollWidth > el.clientWidth) el.scrollTo({ left: li.offsetLeft - (el.clientWidth - li.offsetWidth) / 2, behavior: "smooth" });
  }, [i, to]);

  return (
    <div className="flow-stage" ref={stage}>
      <div className="flow-inner" style={{ "--n": data.actors.length, "--col": col } as CSSProperties}>
        <ol className="flow-actors">
          {data.actors.map((a, k) => (
            <li key={a} className={k === to ? "is-to" : k === from ? "is-from" : undefined}>
              <span>{a}</span>
            </li>
          ))}
        </ol>
        <div className="flow-lane" aria-hidden="true">
          <span className="flow-track" style={{ left: `${center(0)}%`, right: `${100 - center(data.actors.length - 1)}%` }} />
          {data.actors.map((a, k) => (
            <span key={a} className={`flow-stop${k === to || k === from ? " is-on" : ""}`} style={{ left: `${center(k)}%` }} />
          ))}
          {from !== to && (
            <span key={`seg${i}`} className={`flow-seg is-${kind}`} style={{ left: `${center(Math.min(from, to))}%`, width: `${Math.abs(center(to) - center(from))}%` }} />
          )}
          <span
            key={`dot${i}`}
            className={`flow-dot is-${kind}${from === to ? " is-self" : ""}`}
            style={{ "--from": `${center(from)}%`, "--to": `${center(to)}%` } as CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}

export function Flow({ data, heading = "See it move" }: { data: FlowData; heading?: string }) {
  return (
    <Player
      title={data.title}
      heading={heading}
      count={data.steps.length}
      stage={(i) => <FlowStage data={data} i={i} />}
      caption={(i) => {
        const [from, to, label, note, kind = "req", link] = data.steps[i];
        return {
          label,
          note,
          kind,
          link,
          who: (
            <>
              {data.actors[from]}
              {from !== to && (
                <>
                  <ArrowRight size={13} aria-label="to" />
                  {data.actors[to]}
                </>
              )}
            </>
          ),
        };
      }}
    />
  );
}

/** Named containers whose contents change from frame to frame. */
export function Boxes({ data, heading = "See it move" }: { data: BoxesData; heading?: string }) {
  return (
    <Player
      title={data.title}
      heading={heading}
      count={data.frames.length}
      stage={(i) => {
        const frame = data.frames[i];
        const kind = frame.kind ?? "req";
        return (
          <div className="boxes">
            {data.boxes.map((name, b) => (
              <div className="box" key={name}>
                <p>{name}</p>
                <ul>
                  {frame.items[b].length === 0 && <li className="is-empty">empty</li>}
                  {frame.items[b].map((item) => (
                    <li key={item} className={frame.hot?.includes(item) ? `is-hot is-${kind}` : undefined}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      }}
      caption={(i) => ({ label: data.frames[i].label, note: data.frames[i].note, kind: data.frames[i].kind ?? "req" })}
    />
  );
}

/** An animation placed inside a lesson. */
export function SceneView({ scene }: { scene: Scene }) {
  return scene.type === "flow" ? <Flow data={scene} heading="Animation" /> : <Boxes data={scene} heading="Animation" />;
}
