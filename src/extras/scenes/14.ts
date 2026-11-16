import type { Scene } from "../types";

/** Lesson 14, Configuration management. */
export const scenes: Scene[] = [
  {
    type: "boxes",
    after: "precedence",
    title: "Three sources set PORT, one wins",
    boxes: ["Default in code", ".env file", "Real environment", "config.port"],
    frames: [
      {
        items: [["fallback: 3000"], [], [], ["3000"]],
        hot: ["fallback: 3000", "3000"],
        label: "node src/server.js",
        note: "Nothing outside the code sets PORT, so the fallback in the config module is used.",
      },
      {
        items: [["fallback: 3000"], ["PORT=4000"], [], ["4000"]],
        hot: ["PORT=4000", "4000"],
        label: "node --env-file=.env src/server.js",
        note: "The file is closer to this deploy than a default written in code, so it ranks higher.",
        kind: "res",
      },
      {
        items: [["fallback: 3000"], ["PORT=4000"], ["PORT=5000"], ["5000"]],
        hot: ["PORT=5000", "5000"],
        label: "PORT=5000 node --env-file=.env src/server.js",
        note: "Node does not let the file override a variable that is already set. The real environment wins.",
        kind: "res",
      },
      {
        items: [["fallback: 3000"], ["PORT=8080"], ["PORT=5000"], ["5000"]],
        hot: ["PORT=8080", "5000"],
        label: "edit .env to PORT=8080: still 5000",
        note: "A lower source can never override a higher one. When a change seems to be ignored, look for the same key set further up.",
        kind: "err",
      },
    ],
  },
  {
    type: "flow",
    after: "per-environment-config-build-once-configure-many",
    title: "One build promoted through every environment",
    actors: ["Build", "Development", "Staging", "Production"],
    steps: [
      [0, 3, "a separate build for production", "With settings written into the code, each environment needs its own build. Production then runs something nobody tested.", "err"],
      [0, 0, "build linkbox:1.4.2 once", "The fix: one image with no hosts and no passwords inside it."],
      [0, 1, "run linkbox:1.4.2 with a .env file", "On a laptop the values come from a file: LOG_LEVEL=debug and a local Postgres."],
      [0, 2, "run linkbox:1.4.2 with env vars", "Staging starts the same image with its own values: the staging database, LOG_LEVEL=info."],
      [2, 2, "tests pass on staging", "What passed here is this exact image, not a rebuild of it.", "res"],
      [2, 3, "promote linkbox:1.4.2, unchanged", "Promotion moves the image you tested. Nothing is rebuilt on the way."],
      [3, 3, "env vars + secret manager", "Production hands it the production database and its secrets at start time. Only the config differs.", "res"],
    ],
  },
  {
    type: "flow",
    after: "never-commit-secrets",
    title: "A pushed secret cannot be taken back",
    actors: ["Developer", "gitleaks hook", "Public repo", "Scanner", "Database"],
    steps: [
      [0, 2, "git push, with .env in the commit", "The file was never in .gitignore, so git add picked it up with everything else.", "err"],
      [3, 2, "read every new public commit", "Automated scanners watch public pushes for anything shaped like a credential."],
      [3, 4, "connect with the leaked password", "A secret in a public repo is typically found within minutes.", "err"],
      [0, 2, "delete the commit", "Too late. The password is already in clones, caches and the scanner's notes.", "err"],
      [0, 4, "revoke the password, issue a new one", "Rotating is the real fix: the leaked value stops working. Clean the history afterwards.", "res"],
      [0, 1, "next time: git commit", "A pre-commit hook checks the staged changes for anything that looks like a key."],
      [1, 0, "commit blocked: secret found", "The key never leaves the laptop. With .env in .gitignore it would not even be staged.", "res"],
    ],
  },
  {
    type: "boxes",
    after: "rotation",
    title: "Rotating a database credential without an outage",
    boxes: ["Valid in Postgres", "Instance 1 holds", "Instance 2 holds", "Instance 3 holds"],
    frames: [
      {
        items: [["old credential"], ["old credential"], ["old credential"], ["old credential"]],
        label: "one credential, three instances",
        note: "The credential has leaked, or is simply due for a change. It has to be replaced while Linkbox keeps serving.",
      },
      {
        items: [["new credential"], ["old credential"], ["old credential"], ["old credential"]],
        hot: ["old credential"],
        label: "wrong: swap it in one step",
        note: "Every instance now holds a credential that no longer works. All of them fail until the rollout finishes.",
        kind: "err",
      },
      {
        items: [["old credential", "new credential"], ["old credential"], ["old credential"], ["old credential"]],
        hot: ["new credential"],
        label: "1. create the new credential, keep the old",
        note: "Both are valid for now. This overlap is what makes the next steps safe.",
      },
      {
        items: [["old credential", "new credential"], ["new credential"], ["old credential"], ["old credential"]],
        hot: ["new credential"],
        label: "2. roll it out, one instance at a time",
        note: "Instance 1 restarts and reads the new secret. The others keep working, because the old one is still valid.",
      },
      {
        items: [["old credential", "new credential"], ["new credential"], ["new credential"], ["new credential"]],
        hot: ["old credential"],
        label: "3. confirm nothing uses the old one",
        note: "Every instance holds the new secret. Check that no connection still logs in with the old one before the last step.",
      },
      {
        items: [["new credential"], ["new credential"], ["new credential"], ["new credential"]],
        hot: ["new credential"],
        label: "4. revoke the old credential",
        note: "The old value is now useless to whoever has it, and no request failed along the way.",
        kind: "res",
      },
    ],
  },
];
