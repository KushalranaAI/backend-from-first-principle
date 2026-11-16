---
title: What is a backend
part: Orientation
summary: The computer on the other end of every request, what it does, and why that work can't move into the browser.
---

A backend is a program on a computer you control, listening on a network port and answering requests. The frontend is what people see; the backend is where data is kept, rules are enforced and work is done for many users at once. Before learning any framework, you need a clear picture of the whole trip a request makes, because every later lesson is a closer look at one stop on it.

## The first principle

Picture an app with no backend. Each user's browser holds its own copy of the data. You like a friend's post: the like is stored on your laptop and nowhere else. Your friend never sees it. Close the tab and it might be gone. Open the app on your phone and it isn't there.

Three things are missing:

- **A shared place for data.** Many users need to see the same posts, likes and balances. That data has to live somewhere all of them can reach.
- **Someone to enforce the rules.** "You can only delete your own post." "You can't spend money you don't have." If each user's own device checks those rules, each user can switch the checks off.
- **A machine that is always on.** Sending a notification to your friend, charging a card at midnight, resizing an uploaded photo: none of that can wait for someone to keep a browser tab open.

So you put a computer somewhere public, run a program on it that waits for requests, and let every client talk to it. That program is the **backend** (also called the server, or the API when it speaks to other programs instead of people). Everything else in this course is detail on how to build it well.

> A backend is not a language or a framework. It is a role: the trusted, always-on, shared side of an application.

## Core ideas

### What a backend is, concretely

Strip away the vocabulary and a backend is:

1. a computer (a cloud VM, a container, a laptop during development),
2. running a process (Node, Go, Python, Java...),
3. that has opened a **port** (a numbered door, such as 3000 or 443) and waits for connections,
4. reads each request, does some work, often with a database, and writes a response.

The backend **serves** content (HTML, JSON, files) and **accepts** content (form posts, uploads, JSON bodies). Most of the time today it speaks HTTP and sends JSON, which you meet in lessons 02 and 04.

### The trip of one request

You type `https://linkbox.example/api/v1/bookmarks` and press Enter. Here is what happens, in order:

```
browser
  │ 1. DNS: "what IP address is linkbox.example?"  → 203.0.113.10
  │ 2. TCP: open a connection to 203.0.113.10:443 (three-way handshake)
  │ 3. TLS: agree on keys, check the certificate, encrypt everything after this
  │ 4. HTTP: send "GET /api/v1/bookmarks" with headers
  ▼
firewall / load balancer      lets port 443 through, picks a healthy server
  ▼
reverse proxy (nginx, Caddy)  ends TLS, forwards to localhost:3000
  ▼
your app (Node on port 3000)  routing → auth → validation → logic
  ▼
database (Postgres)           SELECT ... WHERE user_id = $1
  ▲
  └─ rows → app turns them into JSON → HTTP response → back the same way
```

1. **DNS** turns a name into an IP address. Your machine asks a resolver, which asks the root servers, then the `.example` servers, then the domain's own name server, and caches the answer for the record's TTL. You buy the domain from a registrar and point an `A` (IPv4) or `AAAA` (IPv6) record at your server.
2. **TCP** opens a reliable, ordered byte stream between your machine and that IP, on port 443 for HTTPS (80 for plain HTTP). This costs one round trip before any data flows.
3. **TLS** wraps that stream in encryption and proves the server owns the domain, using a certificate signed by an authority your browser trusts. TLS 1.3 adds one more round trip. (HTTP/3 merges steps 2 and 3 over QUIC; lesson 02.)
4. **HTTP** is the text the two sides exchange: a method, a path, headers and maybe a body going in; a status code, headers and a body coming out.
5. On the server side, a **firewall** only lets in the ports you opened (on AWS, a security group). A **reverse proxy** usually sits in front of your app: it handles TLS, compresses responses, serves static files and forwards the request to your process on a private port. Your code never needs to run as root or touch certificates.
6. Your **application** routes the request (lesson 03), checks who is asking (lesson 05), checks the input (lesson 06), runs the business logic and talks to the **database** (lesson 09).
7. The response travels back along the same connection. The browser renders it, or your frontend code reads the JSON and updates the page.

Every step can fail on its own: a DNS typo, a closed port, an expired certificate, a crashed process, a slow query. When something is broken in production, this list is the order you check things in.

### Why we need a backend

The first principle gave three reasons. In practice they turn into jobs a backend always ends up doing:

| Job | Example in a bookmarks app |
|---|---|
| Persist shared data | Save a bookmark so it shows up on every device |
| Enforce rules | Only the owner can delete a bookmark |
| Hold secrets | The database password, API keys for email or payments |
| Coordinate users | Tell a user when a shared list changes |
| Do work in the background | Fetch the page title of a saved link, delete old sessions at night |
| Talk to other systems | Call a payment provider, send email, receive webhooks |

A single "like" in a social app touches most of these: store the like, check the user may like this post, bump a counter, queue a notification for the author, and push it to their phone.

### How frontends work

A frontend is code that runs on the user's device. For a web app, the browser:

1. requests a URL and gets back HTML, usually from a CDN or a static file server,
2. fetches the CSS and JavaScript that the HTML points to,
3. builds the page and runs the JavaScript,
4. and from then on that JavaScript calls your backend with `fetch()` to read and change data.

The important part is *where* this runs: inside a browser **sandbox**, on hardware you don't own, controlled by a person you don't know. The sandbox stops a web page from reading the user's files or opening raw network sockets, and the same-origin policy stops it from reading responses from other sites unless they allow it (CORS, lesson 02).

### Why backend logic can't live in the frontend

It is tempting to put the rules in the browser, since the code is there already. It doesn't work, for four reasons:

- **The user controls the client.** Anyone can open DevTools, edit your JavaScript, or skip the browser and send requests with `curl`. A check that only runs in the browser is a suggestion. "The Buy button is disabled when the balance is too low" protects nothing; the server must check the balance.
- **Secrets can't be hidden.** Everything shipped to the browser can be read. A database password or a payment API key in frontend code is public.
- **The browser can't reach your infrastructure.** Postgres and Redis speak their own protocols over TCP. Browsers don't open raw TCP connections, and you would never expose a database to the internet anyway.
- **Clients are many, varied and unreliable.** A web app, an iOS app and a partner's script all use the same data. Phones run on batteries and drop off the network. Rules written once on the server apply to all of them, every time.

The frontend still validates input and hides buttons, because that gives users fast feedback. But the backend is where the decision is made (lesson 06).

## Try it

Watch each step of the trip with tools you already have.

```bash
# 1. DNS: turn a name into addresses
nslookup example.com          # or: dig +short example.com

# 2-4. TCP, TLS and HTTP in one go. Lines with * are connection info,
#      > is what curl sent, < is what came back.
curl -v https://example.com -o /dev/null

# How long each step took, in seconds since the start
curl -o /dev/null -s -w "dns        %{time_namelookup}\nconnect    %{time_connect}\ntls        %{time_appconnect}\nfirst byte %{time_starttransfer}\ntotal      %{time_total}\n" https://example.com
```

The timings are cumulative. `connect - dns` is the TCP handshake, `tls - connect` is the TLS handshake, and `first byte - tls` is the time the server spent thinking. Run it against a site far away from you and watch the handshakes grow.

Then open any web app, press F12, and look at the **Network** tab while you click around. Every row is an HTTP request from the frontend to some backend. Click one and find the method, the status code and the response body.

Break it on purpose:

1. `curl -v https://example.comm`. Which step fails, and what does curl say?
2. `curl -v http://localhost:9999`. Nothing is listening. How is "connection refused" different from a DNS failure?
3. `curl -v https://expired.badssl.com/`. The TLS step fails before any HTTP is sent. Add `-k` to skip the check and see what you would have been trusting.
4. On a site with a disabled button, remove the `disabled` attribute in DevTools and click it. If anything happens, the backend was trusting the frontend.

## Common mistakes

- **Trusting the frontend.** Prices, roles, owner ids and "is this allowed" sent from the browser are user input. Recompute or re-check them on the server.
- **Secrets in frontend code.** API keys in a JavaScript bundle or a mobile app are public the moment you ship. Keep them on the server and have the frontend call your backend instead.
- **Exposing the database to the internet.** Postgres on `0.0.0.0:5432` with an open firewall is found by scanners within hours. Databases live on a private network; only the app talks to them.
- **Running the app as root on port 80.** Put a reverse proxy in front, let it own ports 80 and 443 and TLS, and run your process unprivileged on a high port.
- **Debugging the wrong layer.** "The site is down" can be DNS, TLS, the proxy, the app or the database. Walk the trip in order with `curl -v` before reading application logs.

## Build: Linkbox, step 1

Linkbox is the bookmarks API you build through this course: users sign up, save links with notes and tags, search them, attach files and get notified when things change. This step is about seeing the whole system before writing code.

1. Install **Node.js 22 or newer**, **Docker** (with Compose) and **curl**. Node 22 gets security fixes until April 2027; 24 and 26 are the newer long-term support lines, and any of the three works for this course. Check them: `node -v`, `docker run --rm hello-world`, `curl --version`.
2. Create a `linkbox/` folder, run `npm init -y`, and set `"type": "module"` in `package.json` so every `.js` file is an ES module.
3. In `ARCHITECTURE.md`, sketch the system as a plain-text diagram: **client** (curl for now, a web app later) → **API** (Node) → **Postgres** (users, bookmarks, tags), **Redis** (cache, sessions, job queue), **object storage** (file attachments, S3-compatible) and a **worker** process (fetches page titles in the background). Draw which parts talk to which.
4. Under the diagram, write one line per box saying what it owns and why it can't be done in the client.

**Done when** all three tools print a version, and you can trace a `POST /api/v1/bookmarks` through your diagram out loud, naming every box it touches.

## Check yourself

<details markdown="1">
<summary>You type a URL and press Enter. Name the steps before your server's code runs.</summary>

DNS resolves the name to an IP. TCP opens a connection to that IP on port 443. TLS sets up encryption and checks the certificate. The browser sends the HTTP request. On the server side it passes the firewall or load balancer and usually a reverse proxy, which forwards it to your app's port.
</details>

<details markdown="1">
<summary>Your frontend disables the Delete button for bookmarks the user doesn't own. Is that enough?</summary>

No. Anyone can send `DELETE /api/v1/bookmarks/42` with `curl`, or re-enable the button in DevTools. The server must check ownership on every request. The disabled button is only a nicer user experience.
</details>

<details markdown="1">
<summary>Why can't a web page talk to Postgres directly, even if you wanted it to?</summary>

Postgres speaks its own protocol over raw TCP, and browsers don't let pages open raw TCP sockets. Even if they did, you would have to ship the database password to every user and expose the database to the internet.
</details>

<details markdown="1">
<summary>What does a reverse proxy do that your Node process doesn't have to?</summary>

It accepts connections on ports 80 and 443, terminates TLS, can compress responses, serve static files and balance across several app processes, then forwards plain HTTP to your app on a private port.
</details>

<details markdown="1">
<summary>Name three jobs that need a backend even if every user is honest.</summary>

Sharing data between users and devices, doing work when no browser is open (emails, scheduled cleanup, background processing), and holding secrets such as the database password and third-party API keys.
</details>

## Go deeper

- [MDN: How the web works](https://developer.mozilla.org/en-US/docs/Learn_web_development/Getting_started/Web_standards/How_the_web_works): the client, server, DNS and HTTP picture in plain language.
- [MDN: Client-server overview](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/First_steps/Client-Server_overview): static versus dynamic sites and what a web server does with a request.
- [What happens when...](https://github.com/alex/what-happens-when): the famous interview question answered in detail, from the keyboard interrupt to the rendered page.
- [High Performance Browser Networking: Building blocks of TCP](https://hpbn.co/building-blocks-of-tcp/): why handshakes and round trips dominate web latency. The TLS chapter is next door.
- [MDN: How browsers work](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work): what the frontend does after the bytes arrive.
