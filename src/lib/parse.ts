// Pure helpers shared by the Vite plugin (build time) and the app (run time).

export type Heading = { depth: 2 | 3; text: string; id: string };

export type LessonMeta = {
  slug: string; // "03-routing"
  num: string; // "03"
  title: string;
  part: string;
  summary: string;
  words: number;
  headings: Heading[];
};

/** Splits "---\nkey: value\n---\nbody" into fields and body. Values may contain colons. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { meta: {}, body: src };
  const end = src.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of src.slice(4, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(src.indexOf("\n", end + 1) + 1) };
}

/** Plain text of a Markdown heading: drops code ticks, emphasis and link targets. */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

/** URL-safe id for a heading. Must give the same result for the Markdown source and the rendered text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Calls `onHeading` for every ## and ### heading outside code fences, with its line index. */
function scan(lines: string[], onHeading: (line: number, h: Heading) => void) {
  let fence: string | null = null;
  lines.forEach((line, n) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^(#{2,3})\s+(.+?)\s*#*$/);
    if (h) {
      const text = plainText(h[2]);
      onHeading(n, { depth: h[1].length as 2 | 3, text, id: slugify(text) });
    }
  });
}

/** ## and ### headings outside code fences. */
export function headings(body: string): Heading[] {
  const out: Heading[] = [];
  scan(body.split("\n"), (_, h) => out.push(h));
  return out;
}

/**
 * The body cut at every ## and ### heading. Each piece starts with its heading; the first piece is whatever comes
 * before any heading and has no id. An animation is placed after the piece whose heading id it names.
 */
export function sections(body: string): { id?: string; md: string }[] {
  const lines = body.split("\n");
  const cuts: { line: number; id?: string }[] = [{ line: 0 }];
  scan(lines, (line, h) => cuts.push({ line, id: h.id }));
  return cuts.map((c, k) => ({ id: c.id, md: lines.slice(c.line, cuts[k + 1]?.line).join("\n") })).filter((s) => s.md.trim());
}

export function lessonMeta(file: string, text: string): LessonMeta {
  const slug = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  const { meta, body } = parseFrontMatter(text);
  return {
    slug,
    num: slug.split("-")[0],
    title: meta.title ?? slug,
    part: meta.part ?? "",
    summary: meta.summary ?? "",
    words: (body.match(/\w+/g) ?? []).length,
    headings: headings(body),
  };
}

/** "03-routing.html" (links written for the old static site) → "03-routing"; anything else → null. */
export function lessonLink(href: string): string | null {
  const m = href.match(/^(?:\.\/)?(\d\d-[a-z0-9-]+)\.html(#.*)?$/);
  return m ? m[1] + (m[2] ?? "") : null;
}
