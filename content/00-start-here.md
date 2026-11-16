---
title: How to learn with this course
part: Orientation
summary: The roadmap, the method and the setup. Read this once before lesson 01.
---

Frameworks change every few years. The problems they solve don't. A request still has to be routed, input still has to be checked, data still has to survive a crash, and a server still has to shut down without dropping work. Learn those problems once and any framework or language becomes a new syntax for ideas you already know.

## Why first principles

Most backend tutorials teach a tool: "build a REST API with Express in 20 minutes". That works until something breaks in a way the tutorial never showed. A first-principles course goes the other way. Each lesson asks:

1. **What problem forces this to exist?** What breaks without it?
2. **What is the smallest idea that solves it?** Build that by hand, once.
3. **How do real tools package that idea?** Only now meet the library.

A side effect: you stop being a "Node developer" or a "Go developer". The ideas here are the same in every language. The code is in JavaScript (Node.js) because it's widely read, but nothing in the course depends on it.

## The roadmap

The course has six parts. Each builds on the one before.

| Part | You learn | Lessons |
|---|---|---|
| Orientation | What a backend is and why it exists | 00–01 |
| The request | Everything that happens between a byte arriving and your code running: HTTP, routing, serialization, auth, validation, the layers inside a server, API design | 02–08 |
| Data | Storing, caching, searching and processing data in the background | 09–12 |
| Production | Keeping a service correct and debuggable in the real world: errors, config, observability, shutdown, security | 13–17 |
| Scale | What changes when there is more traffic, more data or bigger files: performance, concurrency, object storage, real-time | 18–21 |
| Engineering practice | How teams build and ship it: testing, twelve-factor, OpenAPI, webhooks, DevOps | 22–26, then the capstone |

Nothing is locked. If you already know HTTP well, skim its *Check yourself* questions. If you can answer them all, move on.

## How to study one lesson

Every lesson has the same six steps. The method is built on the two study techniques with the strongest evidence behind them: **retrieval practice** (pulling an idea out of your memory beats reading it again) and **spacing** (coming back to it days later beats cramming). Building something with each idea is what makes it stick.

1. **Relate.** Read *In real life* at the top. It ties the idea to something you already know, so the details that follow have somewhere to attach.
2. **See it move.** Play the animation under it, then step through it by hand with the arrow buttons. Before each step, guess what happens next. More animations sit inside the lesson, each next to the idea it explains.
3. **Understand.** Read *The first principle* and *Core ideas* properly. This is the reference you'll come back to.
4. **Try it.** Type the commands. Don't paste them. Do the "break it on purpose" steps. Most of the learning happens when something fails and you work out why.
5. **Build.** Do the Linkbox step. This is the part that turns knowing into doing.
6. **Check.** Answer *Check yourself* before opening the answers. Say or write your answer first. Getting it wrong and then reading the answer teaches more than reading it straight away.

Then two habits that cost five minutes and double what you keep:

- **Write five lines** in your own words: what problem the lesson solved, and how. Publish them if you like. Explaining an idea in your own words is the fastest way to find the gaps in it.
- **A week later**, answer that lesson's *Check yourself* questions again, before you start the next lesson.

Tick **I've finished this lesson** at the bottom of the page when you're done. Your progress is saved only in this browser.

## The AI tutor

**Ask AI**, at the top right, opens a tutor that can read the lesson you have open. Use it when you're stuck, not instead of thinking:

- Ask it to explain an idea another way, or with a different everyday example.
- Ask it to quiz you. It asks one question at a time and tells you what you missed.
- Select any sentence in a lesson and press the **Ask AI** button that appears.
- Press **Explain** on a code block to have it walked through line by line.
- On a Build step, ask for a hint before you ask for the answer.

The tutor uses your own API key (Claude, OpenAI or Azure OpenAI). The key is encrypted and kept in your browser, and questions go straight from your browser to the provider. The course works fully without it.

## The project you build: Linkbox

Every lesson adds one step to the same project: **Linkbox**, a bookmarks API. Users sign up, save links with notes and tags, search them, attach files, get live updates and receive webhooks. By lesson 26 it's a tested, documented, observable service in a container with a CI pipeline.

It starts as one file using nothing but Node's standard library, so you see what frameworks do for you before you use one. From lesson 07 it moves to Fastify. Postgres is used with plain SQL throughout, with no ORM hiding the queries. The [capstone](27-capstone.html) has the full spec and a final checklist.

## Setup

You need:

- **Node.js 22 or newer**: [nodejs.org](https://nodejs.org/en/download). Check with `node -v`.
- **Docker**: [Get Docker](https://docs.docker.com/get-started/get-docker/). Postgres, Redis and object storage all run in containers, so nothing else needs installing.
- **curl**: built into macOS, Linux and Windows 10+. You'll use it in almost every lesson.
- **An editor and git.**

You should already be comfortable with basic JavaScript (functions, objects, `async`/`await`), the terminal and git. You don't need to know anything about servers.

## Time

Reading every lesson takes about nine hours. With the experiments and the project, plan on **90–130 hours** in total. At 6–8 hours a week that's three to five months. Going slowly is fine. Skipping the Build steps isn't: they are where most of the learning happens.

## Go deeper

- [roadmap.sh: Backend](https://roadmap.sh/backend): a community map of backend topics. Useful for seeing where this course sits.
- [High Performance Browser Networking](https://hpbn.co/): Ilya Grigorik's free book on TCP, TLS and HTTP. The best companion for lessons 01–02.
- [Designing Data-Intensive Applications](https://dataintensive.net/): Martin Kleppmann's book. Read it after the Data and Scale parts.
- [Node.js best practices](https://github.com/goldbergyoni/nodebestpractices): a long, practical checklist to compare your Linkbox against.
- [retrievalpractice.org](https://www.retrievalpractice.org/): short, readable guides to the study techniques used above.
