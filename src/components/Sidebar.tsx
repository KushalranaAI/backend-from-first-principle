import { useEffect, useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Check, Search, Server, X } from "lucide-react";
import { LESSONS, PARTS } from "../course";
import { useDone } from "../progress";

/** Progress as a small ring: the number in the middle, the arc around it. */
export function Ring({ value, total, size = 44 }: { value: number; total: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${total} lessons done`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-value" strokeDasharray={c} strokeDashoffset={c * (1 - value / total)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {Math.round((value / total) * 100)}%
      </text>
    </svg>
  );
}

/** The course outline. A fixed column on wide screens, a drawer on small ones. */
export function Sidebar({ open, onClose, onSearch }: { open: boolean; onClose: () => void; onSearch: () => void }) {
  const [done] = useDone();
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  const count = LESSONS.filter((l) => done[l.slug]).length;

  // Keep the current lesson visible in the outline.
  useEffect(() => {
    nav.current?.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
  }, [pathname]);

  return (
    <>
      <div className={`scrim${open ? " is-open" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside className={`side${open ? " is-open" : ""}`} aria-label="Course outline">
        <div className="side-head">
          <Link className="brand" to="/" onClick={onClose}>
            <span className="brand-mark">
              <Server size={16} />
            </span>
            <span>
              <b>Backend</b>
              <small>from first principles</small>
            </span>
          </Link>
          <button type="button" className="icon-btn side-close" onClick={onClose} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <button type="button" className="side-search" onClick={onSearch}>
          <Search size={15} />
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="side-progress">
          <Ring value={count} total={LESSONS.length} />
          <p>
            <b>
              {count} of {LESSONS.length}
            </b>
            <span>lessons finished</span>
          </p>
        </div>

        <nav ref={nav}>
          {PARTS.map((part, n) => (
            <section key={part.title}>
              <h2>
                <span>{n}</span>
                {part.title}
              </h2>
              <ol>
                {part.lessons.map((l) => (
                  <li key={l.slug}>
                    <NavLink to={`/${l.slug}`} onClick={onClose} className={({ isActive }) => `${isActive ? "is-current" : ""}${done[l.slug] ? " is-done" : ""}`}>
                      <span className="tick">{done[l.slug] ? <Check size={12} strokeWidth={3} /> : l.num}</span>
                      {l.title}
                    </NavLink>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </nav>
      </aside>
    </>
  );
}
