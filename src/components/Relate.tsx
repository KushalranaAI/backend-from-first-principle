import { ArrowRight } from "lucide-react";
import type { Extra } from "../extras";

/** The relatable layer of a lesson: an everyday comparison, how it maps to the idea, and where you've met it already. */
export function Relate({ extra }: { extra: Extra }) {
  const { analogy, uses } = extra;
  return (
    <section className="relate" aria-labelledby="in-real-life">
      <div className="relate-story">
        <p className="eyebrow">In real life</p>
        <h2 id="in-real-life">{analogy.title}</h2>
        <p>{analogy.text}</p>
      </div>

      <dl className="relate-map">
        <div className="relate-map-head" aria-hidden="true">
          <span>In the story</span>
          <span />
          <span>In your backend</span>
        </div>
        {analogy.map.map(([everyday, backend]) => (
          <div key={everyday}>
            <dt>{everyday}</dt>
            <ArrowRight size={14} aria-hidden="true" />
            <dd>{backend}</dd>
          </div>
        ))}
      </dl>

      <div className="relate-uses">
        <p className="eyebrow">You have already met this</p>
        <ul>
          {uses.map(([where, what]) => (
            <li key={where}>
              <strong>{where}</strong>
              <span>{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
