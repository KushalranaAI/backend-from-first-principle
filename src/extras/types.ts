/** What a step is about: a request (rust), a response or success (teal), or something going wrong (red). */
export type Kind = "req" | "res" | "err";

/** [from actor, to actor, label, one-sentence note, kind?, lesson slug to link to?]. from === to means "works on its own". */
export type Step = [from: number, to: number, label: string, note: string, kind?: Kind, link?: string];

/** Messages moving between actors: a request path, a handshake, a pipeline. */
export type FlowData = { title: string; actors: string[]; steps: Step[] };

/**
 * One moment in a "boxes" animation.
 * - `items[b]` is what box `b` holds at this moment, as short labels. A label that stays in the same box across
 *   frames stays put; a new label animates in.
 * - `hot` lists the labels this frame is about; they are highlighted in the frame's colour.
 */
export type Frame = { items: string[][]; label: string; note: string; hot?: string[]; kind?: Kind };

/** Named containers whose contents change: a queue, a cache, a call stack, a pool, a table. */
export type BoxesData = { title: string; boxes: string[]; frames: Frame[] };

/**
 * An animation placed inside a lesson. `after` is the id of the ## or ### heading whose section it follows
 * (the heading text lowercased, punctuation dropped, spaces as hyphens: "Matching order and specificity" →
 * "matching-order-and-specificity").
 */
export type Scene = ({ type: "flow" } & FlowData & { after: string }) | ({ type: "boxes" } & BoxesData & { after: string });

export type Extra = {
  /** An everyday comparison, and how each part of it maps to the backend idea. */
  analogy: { title: string; text: string; map: [everyday: string, backend: string][] };
  /** Places the learner has already met this idea: [where, what is happening]. */
  uses: [where: string, what: string][];
  /** The lesson's opening animation, shown under the comparison. */
  flow: FlowData;
};
