# Backend from first principles

[![CI](https://github.com/KushalranaAI/backend-from-first-principle/actions/workflows/ci.yml/badge.svg)](https://github.com/KushalranaAI/backend-from-first-principle/actions/workflows/ci.yml)

**[Open the hosted copy →](https://kushalranaai.github.io/backend-from-first-principle/)** (the AI tutor works there too: paste your own key in the panel.)

Part of **[Learn in Public](https://kushalranaai.github.io/learn-in-public/)**: free, connected roadmaps from your first class to production AI systems.

A self-paced course in how servers actually work, as a web app. 28 lessons take you from one HTTP request to a
tested, documented service running in a container. Every lesson starts from the problem an idea solves.

- **Relate**: each lesson opens with an everyday comparison and three places you have already met the idea.
- **Animated**: step-through animations sit beside the ideas they explain. Play them or step by hand.
- **Build**: every lesson adds one step to Linkbox, a bookmarks API you grow across the course.
- **Ask AI**: an optional tutor that reads the lesson you have open. It uses your own API key.
- **Yours**: progress is saved in your browser. No account, no tracking.

## Run it

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm start          # opens http://localhost:5180
```

Other commands: `npm test` (unit tests and content checks), `npm run build` (type-check and build into `dist/`),
`npm run preview` (serve the build).

## The AI tutor

Press **Ask AI** (or <kbd>Ctrl</kbd> + <kbd>J</kbd>) and connect a provider: Claude, OpenAI or Azure OpenAI.

- **In the browser.** Paste your key in the tutor panel. It is encrypted before it is stored, stays on your device,
  and is sent only to the provider you chose.
- **In `.env` (when you run the app locally).** Copy `.env.example` to `.env` and fill in a key. The local dev server
  attaches it to requests, so the browser never sees it. This does not work on a static host.

Each question sends the text of the lesson you are on to the provider. The course works fully without a key.

## How it is put together

```
content/NN-slug.md          the lesson text, one Markdown file each; the file name sets the order
src/extras/part1.ts, part2.ts   each lesson's everyday comparison, real-world uses and opening animation
src/extras/scenes/NN.ts     the animations placed inside lesson NN
src/components/Scene.tsx    the animation player (two stages: messages between actors, boxes whose contents change)
src/components/Tutor.tsx    the AI tutor panel; src/ai/ holds the provider calls and the encrypted key store
src/pages/                  Home (overview) and Lesson
server/ai-relay.ts          the local-only relay for keys kept in .env
CONTENT_GUIDE.md            how to write a lesson and its animations
```

To add or change a lesson, follow [CONTENT_GUIDE.md](CONTENT_GUIDE.md), then run `npm test`: it checks that every
animation is well formed and points at a real heading in its lesson.

## Host it

`npm run build` produces a static site in `dist/` that works from any folder or static host. This repo's workflow
(`.github/workflows/ci.yml`) tests, builds and publishes it to GitHub Pages on every push to `main`. In the repository's
**Settings → Pages**, set the source to **GitHub Actions** once.

## Credit

Built by [Kushal Rana](https://kushalranaai.github.io/), part of
[Learn in Public](https://kushalranaai.github.io/learn-in-public/). The credit strip at the bottom of every page
(`src/components/Credit.tsx`, details in `src/brand.ts`) also notes that the topic outline is referenced from the
[Backend from first principles](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1) YouTube
playlist. The lessons, examples and animations are original.
