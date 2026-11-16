# Security policy

Backend from first principles is a learning app. It runs in your browser, has no accounts and no backend of its own, and
keeps your progress in `localStorage`. The only secret it can touch is an AI provider key you choose to paste in for the
optional tutor.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately with GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/KushalranaAI/backend-from-first-principle/security/advisories/new>).

Include what you found, how to reproduce it, and the impact you think it has. I will respond as soon as I can, and
credit you in the fix unless you prefer not to be named.

## What is in scope

- The app and its build (`src/`, `server/`, `vite.config.ts`).
- The GitHub Actions workflow in `.github/`.
- Content that could run code or leak data when a learner follows it.

Examples that matter: cross-site scripting through lesson Markdown or shared links, anything that exposes or exfiltrates
an AI key you entered, and the optional dev relay (`/api/ai-proxy`, `/api/ai-server`) forwarding to a host it should not.

Lessons teach attacks only so that you can defend against them. A lesson explaining SQL injection is not a vulnerability
report; a lesson whose example code is itself unsafe to copy is.

## How AI keys are handled

- A key you paste into the tutor is encrypted in the browser before it is stored, and is used only to call the AI
  provider you chose. The app is static; there is no server of mine in the middle.
- Each tutor question sends the text of the lesson you have open to that provider.
- For local development the optional relay forwards only to known AI provider hosts (OpenAI, Anthropic, Azure OpenAI),
  only answers requests from the local app, and does not store or log keys.
- Keys you keep in a local `.env` stay on your machine. `.env` is git-ignored; only `.env.example` is committed.
  **Never commit a real key.** Secret scanning and push protection are enabled on this repository.
- The production build ships a Content-Security-Policy that limits scripts to the app's own and network calls to the AI
  providers.

## Protecting this repository

`main` cannot be deleted or force-pushed, and changes reach it through a pull request that the owner approves and that
passes CI. The rulesets are exported in [`.github/rulesets/`](.github/rulesets/README.md). Workflow actions are pinned to
exact commits, and the workflow runs with read-only permissions except for the Pages deploy job.

## Supported versions

Only the latest commit on `main` (the version deployed to GitHub Pages) is supported.

## Dependencies

Dependabot watches npm packages and GitHub Actions weekly, and security updates open automatically. Code scanning
(CodeQL) runs on every push to `main` and on pull requests.
