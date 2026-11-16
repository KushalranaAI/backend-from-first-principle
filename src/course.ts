import lessons from "virtual:course";
import { parseFrontMatter, type LessonMeta } from "./lib/parse";
import type { Scene } from "./extras";

export const LESSONS: LessonMeta[] = lessons;

export const bySlug = new Map(LESSONS.map((l, i) => [l.slug, { lesson: l, index: i }]));

/** Reading time in minutes, at a careful 220 words a minute. */
export const readMinutes = (l: LessonMeta) => Math.max(1, Math.round(l.words / 220));

export const PARTS: { title: string; lessons: LessonMeta[] }[] = [];
for (const l of LESSONS) {
  if (PARTS.at(-1)?.title !== l.part) PARTS.push({ title: l.part, lessons: [] });
  PARTS.at(-1)!.lessons.push(l);
}

// A lesson's text and its animations are split into their own chunks and fetched when the lesson opens.
const bodies = import.meta.glob("../content/[0-9][0-9]-*.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const sceneFiles = import.meta.glob("./extras/scenes/[0-9][0-9].ts", { import: "scenes" }) as Record<string, () => Promise<Scene[]>>;

export type Loaded = { body: string; scenes: Scene[] };
const cache = new Map<string, Loaded>();

export const cached = (slug: string): Loaded | undefined => cache.get(slug);

export async function load(slug: string): Promise<Loaded> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const scenes = sceneFiles[`./extras/scenes/${slug.slice(0, 2)}.ts`];
  const [text, list] = await Promise.all([bodies[`../content/${slug}.md`](), scenes ? scenes() : []]);
  const loaded = { body: parseFrontMatter(text).body, scenes: list };
  cache.set(slug, loaded);
  return loaded;
}
