import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { headings, parseFrontMatter } from "../lib/parse";
import { COURSE_FLOW, EXTRAS } from "./index";
import type { FlowData, Scene } from "./types";

const CONTENT = resolve(__dirname, "../../content");
const lessonFiles = readdirSync(CONTENT).filter((f) => /^\d\d-.*\.md$/.test(f));
const sceneModules = import.meta.glob<{ scenes: Scene[] }>("./scenes/[0-9][0-9].ts", { eager: true });

const KINDS = [undefined, "req", "res", "err"];

function checkFlow(name: string, flow: FlowData) {
  expect(flow.actors.length, `${name}: 2 to 6 actors`).toBeGreaterThanOrEqual(2);
  expect(flow.actors.length, `${name}: 2 to 6 actors`).toBeLessThanOrEqual(6);
  expect(new Set(flow.actors).size, `${name}: actor names are unique`).toBe(flow.actors.length);
  expect(flow.steps.length, `${name}: 4 to 10 steps`).toBeGreaterThanOrEqual(4);
  expect(flow.steps.length, `${name}: 4 to 10 steps`).toBeLessThanOrEqual(10);
  for (const [from, to, label, note, kind] of flow.steps) {
    expect(flow.actors[from], `${name}: "${label}" starts at an actor that exists`).toBeDefined();
    expect(flow.actors[to], `${name}: "${label}" ends at an actor that exists`).toBeDefined();
    expect(label.trim() && note.trim(), `${name}: "${label}" has a label and a note`).toBeTruthy();
    expect(label.length, `${name}: label "${label}" is at most 60 characters`).toBeLessThanOrEqual(60);
    expect(KINDS, `${name}: "${label}" kind`).toContain(kind);
  }
}

describe("lesson extras", () => {
  it("every lesson except 00 and 27 has a comparison, real-world uses and an opening animation", () => {
    for (const file of lessonFiles) {
      const num = file.slice(0, 2);
      if (num === "00" || num === "27") continue;
      const extra = EXTRAS[num];
      expect(extra, `lesson ${num} is missing from EXTRAS`).toBeDefined();
      expect(extra.analogy.map.length).toBeGreaterThanOrEqual(4);
      expect(extra.uses.length).toBeGreaterThanOrEqual(3);
      checkFlow(`lesson ${num} opening flow`, extra.flow);
    }
    checkFlow("course flow", COURSE_FLOW);
  });
});

describe("lesson animations (src/extras/scenes/NN.ts)", () => {
  const entries = Object.entries(sceneModules);

  it("there is at least the reference file", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [path, mod] of entries) {
    const num = path.match(/(\d\d)\.ts$/)![1];
    const file = lessonFiles.find((f) => f.startsWith(num));

    it(`${num}: every animation is well formed and sits after a real heading`, () => {
      expect(file, `no lesson file starts with ${num}`).toBeDefined();
      const ids = headings(parseFrontMatter(readFileSync(resolve(CONTENT, file!), "utf8")).body).map((h) => h.id);
      expect(mod.scenes.length, `${num}: 3 to 5 animations`).toBeGreaterThanOrEqual(3);
      expect(mod.scenes.length, `${num}: 3 to 5 animations`).toBeLessThanOrEqual(5);
      expect(new Set(mod.scenes.map((s) => s.title)).size, `${num}: titles are unique`).toBe(mod.scenes.length);

      for (const scene of mod.scenes) {
        const name = `${num} "${scene.title}"`;
        expect(ids, `${name}: after "${scene.after}" is not a heading id in ${file}. Ids: ${ids.join(", ")}`).toContain(scene.after);
        if (scene.type === "flow") {
          checkFlow(name, scene);
          continue;
        }
        expect(scene.boxes.length, `${name}: 2 to 4 boxes`).toBeGreaterThanOrEqual(2);
        expect(scene.boxes.length, `${name}: 2 to 4 boxes`).toBeLessThanOrEqual(4);
        expect(scene.frames.length, `${name}: 3 to 9 frames`).toBeGreaterThanOrEqual(3);
        expect(scene.frames.length, `${name}: 3 to 9 frames`).toBeLessThanOrEqual(9);
        for (const frame of scene.frames) {
          expect(frame.items.length, `${name}: "${frame.label}" gives items for every box`).toBe(scene.boxes.length);
          expect(frame.label.trim() && frame.note.trim(), `${name}: "${frame.label}" has a label and a note`).toBeTruthy();
          expect(frame.label.length, `${name}: label "${frame.label}" is at most 60 characters`).toBeLessThanOrEqual(60);
          expect(KINDS, `${name}: "${frame.label}" kind`).toContain(frame.kind);
          const all = frame.items.flat();
          for (const box of frame.items) {
            expect(new Set(box).size, `${name}: "${frame.label}" repeats a label inside one box`).toBe(box.length);
            expect(box.length, `${name}: "${frame.label}" has at most 6 items in a box`).toBeLessThanOrEqual(6);
            for (const item of box) expect(item.length, `${name}: item "${item}" is at most 28 characters`).toBeLessThanOrEqual(28);
          }
          for (const hot of frame.hot ?? []) expect(all, `${name}: "${frame.label}" highlights "${hot}", which is in no box`).toContain(hot);
        }
      }
    });
  }
});
