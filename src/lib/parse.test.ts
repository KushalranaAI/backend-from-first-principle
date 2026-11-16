import { describe, expect, it } from "vitest";
import { headings, lessonLink, parseFrontMatter, plainText, sections, slugify } from "./parse";

describe("parse", () => {
  it("reads front matter, keeping colons in values", () => {
    const { meta, body } = parseFrontMatter("---\r\ntitle: Capstone: finish\r\npart: Finish\r\n---\r\n\r\nHello");
    expect(meta).toEqual({ title: "Capstone: finish", part: "Finish" });
    expect(body.trim()).toBe("Hello");
  });

  it("finds headings outside code fences, including fences inside list items", () => {
    const md = ["## One", "```js", "## not a heading", "```", "1. step", "   ```bash", "   # comment", "   ```", "### Two `code`"].join("\n");
    expect(headings(md)).toEqual([
      { depth: 2, text: "One", id: "one" },
      { depth: 3, text: "Two code", id: "two-code" },
    ]);
  });

  it("cuts a body into sections at headings, ignoring headings inside code", () => {
    const md = ["Intro.", "", "## One", "text", "```md", "## fake", "```", "### Two", "more"].join("\n");
    expect(sections(md)).toEqual([
      { id: undefined, md: "Intro.\n" },
      { id: "one", md: "## One\ntext\n```md\n## fake\n```" },
      { id: "two", md: "### Two\nmore" },
    ]);
  });

  it("slugs source and rendered text the same way", () => {
    expect(slugify(plainText("Build: Linkbox, step 8"))).toBe("build-linkbox-step-8");
    expect(slugify(plainText("404 versus `405`"))).toBe("404-versus-405");
    expect(slugify("Path parameters and query parameters")).toBe("path-parameters-and-query-parameters");
  });

  it("maps old static links to lesson slugs", () => {
    expect(lessonLink("27-capstone.html")).toBe("27-capstone");
    expect(lessonLink("02-http.html#cors")).toBe("02-http#cors");
    expect(lessonLink("https://example.com/a.html")).toBeNull();
  });
});
