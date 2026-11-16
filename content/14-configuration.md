---
title: Configuration management
part: Production
summary: How to keep everything that changes between environments out of your code, check it before the server starts, and keep secrets out of git.
---

The same Linkbox code runs on your laptop, in CI, in staging and in production. What differs is the database it talks to, the port it listens on, how much it logs and which passwords it holds. Configuration is that set of differences. Handle it carelessly and you get the classic incidents: a staging server writing to the production database, a password pushed to GitHub, a typo in a variable name that nobody notices until 3 a.m.

## The first principle

Start with a server that has its settings written into the code:

```js
const pool = new pg.Pool({ connectionString: "postgres://linkbox:hunter2@localhost:5432/linkbox" });
app.listen({ port: 3000 });
```

Three things are now broken:

1. **You can't deploy it.** Production's database is not on `localhost`. To change it you edit code, which means a new build per environment, so the thing you tested is not the thing you ship.
2. **The password is in git.** Everyone with read access to the repo, every fork, every CI log and every laptop that ever cloned it now has the production password. Forever, because git keeps history.
3. **Nobody can see what the app needs.** The settings are scattered through files. A new teammate learns them by reading code or by crashing.

The fix is a strict line: **code is the same everywhere; configuration is whatever changes between deploys.** The build produces one artifact. Each environment hands it different config at start time. The Twelve-Factor App states the test well: could you make the repository public right now without leaking any credentials? If not, config is mixed into your code.

Then a second rule: since config now comes from outside, the app can't trust it. Check every value **once, at startup**, and refuse to start if anything is wrong.

## Core ideas

### What counts as configuration

Config is anything that varies between deploys or that operators should change without a code change:

| Type | Linkbox examples | Notes |
|---|---|---|
| App settings | `PORT`, `LOG_LEVEL`, page size limit, fetch timeout | Safe to show, have sensible defaults |
| Secrets | database password, Redis password, API keys, signing keys | Never logged, never committed, rotated |
| Feature flags | `FEATURE_ENRICH_ON_CREATE=false` | Turn behaviour on and off without deploying |
| Infrastructure | `DATABASE_URL` host, `REDIS_URL`, S3 bucket name | Set by whoever runs the platform |

Things that do **not** belong in config: route definitions, business rules that never change between environments, and anything you'd want to review in a pull request because it changes behaviour for everyone. Making everything configurable is a trap: each knob is a code path you must test.

### Where config comes from

| Source | Good for | Watch out for |
|---|---|---|
| Defaults in code | Values that are almost always right (`PORT=3000`) | Never default a secret or a production host |
| Config files (JSON, YAML) | Large, structured, non-secret settings | Ends up in git; per-env file sprawl |
| Environment variables | Per-deploy values, supported by every platform | Flat strings only; easy to leak (see below) |
| `.env` file | Local development | Must never be committed |
| Secret manager | Secrets in staging and production | Another dependency at startup |
| Command-line flags | One-off overrides | Visible in `ps` output |

Environment variables won because every platform supports them: Docker (`-e`, `env_file`), Kubernetes (`env`, `envFrom`), systemd, Heroku, Fly, Render, GitHub Actions. Your app reads `process.env` and doesn't care which one set them.

### Precedence

When the same key is set in several places, one rule must decide. The usual order, lowest to highest:

```
defaults in code  <  config file  <  .env file  <  real environment  <  CLI flags
```

The more specific and the closer to the deploy, the higher it ranks. Node's own `--env-file` follows this: if a variable is already in the environment, the file does not override it. That lets you keep a `.env` for local defaults and still override one value from the shell:

```bash
PORT=5000 node --env-file=.env src/server.js   # PORT is 5000 even if .env says 4000
```

### Per-environment config: build once, configure many

Each environment gets its own values, not its own code:

```
          same image: linkbox:1.4.2
       ┌────────────┼──────────────┐
   development    staging       production
   .env file      env vars       env vars + secret manager
   LOG_LEVEL=debug LOG_LEVEL=info LOG_LEVEL=info
   local Postgres  staging DB     production DB
```

Avoid sprinkling `if (process.env.NODE_ENV === "production")` through the code. Each one is behaviour you can't test anywhere but production. Instead, make the behaviour itself a setting (`LOG_PRETTY=false`, `COOKIE_SECURE=true`) and let each environment set it. Keep `NODE_ENV` to its traditional meaning, which libraries read: `production` turns off dev-only checks.

### Validate at startup and fail fast

`process.env` values are strings or `undefined`. `Number("3OOO")` is `NaN`. `"false"` is truthy. A missing `DATABASE_URL` might not fail until the first request needs the database, maybe an hour after deploy, maybe only for one endpoint.

So read all config in one module, convert each value to its real type, check it, and exit with a clear message if anything is wrong:

```js
// src/config.js: the only file that reads process.env
const errors = [];

function read(name, { parse = (v) => v, fallback, secret = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) errors.push(`${name} is required`);
    return fallback;
  }
  try {
    return parse(raw);
  } catch (err) {
    // Never echo a secret's value, even when it's wrong.
    errors.push(`${name} ${secret ? "is invalid" : `= "${raw}": ${err.message}`}`);
  }
}
```

Small parsers turn strings into checked values. Each one throws with a message a human can act on:

```js
const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be an integer from ${min} to ${max}`);
  return n;
};
const oneOf = (...allowed) => (v) => {
  if (!allowed.includes(v)) throw new Error(`must be one of: ${allowed.join(", ")}`);
  return v;
};
const url = (...protocols) => (v) => {
  const u = new URL(v); // throws on garbage
  if (!protocols.includes(u.protocol)) throw new Error(`must start with ${protocols.join(" or ")}`);
  return v;
};
const bool = (v) => {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error("must be true or false");
};
```

Then the config itself, one place that lists everything the app needs:

```js
const config = {
  env: read("NODE_ENV", { parse: oneOf("development", "test", "production"), fallback: "development" }),
  host: read("HOST", { fallback: "127.0.0.1" }),
  port: read("PORT", { parse: int(1, 65535), fallback: 3000 }),
  logLevel: read("LOG_LEVEL", { parse: oneOf("fatal", "error", "warn", "info", "debug", "trace"), fallback: "info" }),
  databaseUrl: read("DATABASE_URL", { parse: url("postgres:", "postgresql:"), secret: true }),
  redisUrl: read("REDIS_URL", { parse: url("redis:", "rediss:"), secret: true }),
  fetchTimeoutMs: read("FETCH_TIMEOUT_MS", { parse: int(100, 60_000), fallback: 5000 }),
  features: {
    enrichOnCreate: read("FEATURE_ENRICH_ON_CREATE", { parse: bool, fallback: true }),
  },
};

if (errors.length > 0) {
  console.error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}

export default Object.freeze(config);
```

Three choices here matter more than the code:

- **Collect all errors, then exit.** Reporting one missing variable per deploy attempt wastes an afternoon.
- **Exit before listening.** An orchestrator sees the crash and keeps the old version running. A server that starts and then fails on every request looks healthy until users complain.
- **Freeze it and import it.** The rest of the code does `import config from "./config.js"` and never touches `process.env`. Tests can build a config object without setting globals.

Hand-written parsers are fine for a dozen keys. For larger apps, schema libraries do the same job: `env-schema` / `@fastify/env` (JSON Schema, which you already know from Fastify routes) or Zod's `z.object(...).parse(process.env)`.

### `.env` files and `node --env-file`

Typing ten variables before every `node` command gets old, so local development uses a `.env` file:

```bash
# .env (local only, never committed)
DATABASE_URL=postgres://linkbox:linkbox@localhost:5432/linkbox
REDIS_URL=redis://localhost:6379
LOG_LEVEL=debug
```

Node reads it natively; the `dotenv` package is no longer needed:

```bash
node --env-file=.env src/server.js
node --env-file-if-exists=.env src/server.js   # no error if the file is missing (Node 22.9+)
node --env-file=.env --env-file=.env.local src/server.js   # later files override earlier ones
```

`--env-file` has been in Node since 20.6 and lost its experimental label in 22.21 and 24.10. From code, `process.loadEnvFile(".env")` does the same.

Commit a **`.env.example`** with every key and a fake or empty value. It's the documentation for "what does this app need?", and new teammates copy it to `.env`. Your config module is the real source of truth, so keep the two in sync.

### Never commit secrets

A secret pushed to a public repo is typically found by scanners within minutes. Private repos leak through forks, laptops and CI logs. Defences, in order:

1. **`.gitignore` the file before you create it.** Add `.env` and `.env.*` (but keep `!.env.example`).
2. **Scan before commit.** A pre-commit hook with [gitleaks](https://github.com/gitleaks/gitleaks) catches keys by pattern. gitleaks is now feature complete and only gets security fixes; its author's newer scanner, [Betterleaks](https://github.com/betterleaks/betterleaks), runs as a pre-commit hook too and can also check whether a key it found still works. GitHub's push protection blocks known token formats at push time.
3. **If a secret leaks, rotate it.** Deleting the commit isn't enough; it's in clones, caches and the attacker's notes. Revoke the credential and issue a new one first, clean history second.

### Secret managers

In staging and production, secrets belong in a system built for them:

| Tool | What it is |
|---|---|
| HashiCorp Vault / OpenBao | Self-hosted secret store; can mint short-lived database credentials on demand |
| AWS Secrets Manager, GCP Secret Manager, Azure Key Vault | Cloud-managed stores with access control through the cloud's IAM, audit logs and scheduled rotation |
| Doppler, Infisical | Hosted secret managers that sync secrets to every platform and inject them at run time |
| Kubernetes Secrets | Built in, but only base64-encoded; enable encryption at rest and RBAC, or back them with one of the above |

What they give you over a file on a server: access control (who and which service may read which secret), an audit log (who read it, when), versioning, and rotation. Tools like Doppler can run your app with secrets injected as env vars, so the app code doesn't change: `doppler run -- node src/server.js`.

### Rotation

Any secret will leak eventually: a former employee, a log line, a compromised laptop. Rotation limits how long a leaked secret is useful. Rotating safely needs an overlap window:

```
1. create the new credential        (old and new both valid)
2. roll it out to every instance    (restart, or re-read the secret)
3. confirm nothing uses the old one
4. revoke the old credential
```

Skip step 1 and every instance fails until the deploy finishes. Rotation you do once a year by hand is rotation you'll get wrong; automate it, or use short-lived credentials (Vault's database secrets engine, cloud IAM roles) so there's nothing long-lived to rotate.

### Why env vars for secrets is debated

The Twelve-Factor App says put config, secrets included, in environment variables. Many security teams push back, for real reasons:

- Every child process inherits the whole environment, including ones you didn't write.
- On Linux, `/proc/<pid>/environ` exposes it to the same user and root. `docker inspect` shows env vars set on a container.
- Crash reporters, debug pages and "print the environment" CI steps dump it into logs.

The common middle ground: **non-secret config in env vars; secrets either fetched from a secret manager at startup or mounted as files** with tight permissions (Docker and Kubernetes secrets are mounted under a path like `/run/secrets/`). Many images support a `_FILE` convention for this, for example the official Postgres image reads `POSTGRES_PASSWORD_FILE`. Supporting it in your `read()` is a few lines: if `DATABASE_URL_FILE` is set, read the file. Whichever you choose, read secrets once, keep them in memory, and never log the config object as a whole.

### Feature flags

A feature flag is config that switches code paths. The simplest is an env var read at startup. Martin Fowler's taxonomy separates them by lifetime:

- **Release toggles**: ship unfinished code dark, remove the flag once launched. Days to weeks.
- **Ops toggles / kill switches**: turn off an expensive feature during an incident. `FEATURE_ENRICH_ON_CREATE=false` stops Linkbox from enqueuing metadata fetches if the queue is drowning.
- **Experiment and permission toggles**: per user or per percentage. These need a flag service (LaunchDarkly, Unleash, Flagsmith, or OpenFeature as a vendor-neutral API) because they change at run time, not at deploy.

Every flag is a branch you must test both ways. Give each one an owner and a removal date.

## Try it

Copy the config module above into `config.js` in a folder with `"type": "module"`, plus a two-line `show.js`:

```js
import config from "./config.js";
console.log(config);
```

```bash
node show.js                                    # exits 1: DATABASE_URL and REDIS_URL are required
echo $?                                         # 1

cat > .env <<'EOF'
DATABASE_URL=postgres://linkbox:linkbox@localhost:5432/linkbox
REDIS_URL=redis://localhost:6379
PORT=4000
EOF
node --env-file=.env show.js                    # port: 4000
PORT=5000 node --env-file=.env show.js          # port: 5000. The real environment wins.
PORT=abc node --env-file=.env show.js           # PORT = "abc": must be an integer from 1 to 65535
DATABASE_URL=mysql://u:topsecret@db/x node --env-file=.env show.js   # "is invalid", no password printed
```

Now break it on purpose:

1. Delete the `secret: true` on `databaseUrl` and repeat the last command. Where did the password end up? Imagine that line in a log aggregator.
2. Set `FEATURE_ENRICH_ON_CREATE=False` (capital F). Should that be accepted? Decide, then make the parser agree.
3. Run `git init`, then `git status` without a `.gitignore`. Notice `.env` listed as a file you could add. Now add the `.gitignore` and look again.

## Common mistakes

- **Reading `process.env` all over the code.** Typos (`DATABSE_URL`) silently become `undefined`. One config module, one place to look, one place to validate.
- **Defaults for secrets or production hosts.** `process.env.DATABASE_URL ?? "postgres://localhost/linkbox"` means a missing variable in production quietly points at the wrong database. Required values have no default.
- **Validating lazily.** A bad value found on the first request, an hour after the deploy, is an outage. Validate everything before `listen`.
- **Logging the whole config at startup.** It's handy and it prints every secret. Log a redacted copy, or only the non-secret keys.
- **Committing `.env`**, or a "temporary" key in a test file. Ignore it from day one, scan in pre-commit, rotate anything that leaks.
- **One config file per environment in the repo** (`config.production.json` with real hosts). It drifts, and it puts production details in git. Keep per-environment values in the environment.

## Build: Linkbox, step 14

Linkbox reads settings in several places by now: the port in the server, the database URL in the pool, the Redis URL in the cache and the queue.

1. Create `src/config.js` as in this lesson. Include at least `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, the metadata `FETCH_TIMEOUT_MS` and one feature flag.
2. Replace every `process.env.X` elsewhere with `config.x`. Search to prove it: `grep -rn "process.env" src/` should only find `config.js`.
3. Import `config.js` first in `src/server.js` and the worker entry point, so a bad config exits before any connection is opened.
4. Add `.env.example` with every key and placeholder values. Add `.env` and `.env.*` (with `!.env.example`) to `.gitignore`.
5. Update the `npm` scripts to `node --env-file-if-exists=.env src/server.js`, so development uses `.env` and production uses the real environment.
6. Optional: support `DATABASE_URL_FILE` so the password can come from a mounted secret file instead of an env var.

**Done when** starting Linkbox with a missing or malformed variable prints every problem at once and exits with code 1, `.env` is ignored by git, and no file but `config.js` reads `process.env`.

## Check yourself

<details markdown="1">
<summary>What is the dividing line between code and configuration?</summary>

Configuration is whatever varies between deploys (hosts, credentials, ports, log levels, flags). Code is the same in every environment. One build artifact should run anywhere, given different config.
</details>

<details markdown="1">
<summary>Why validate config at startup instead of when a value is first used?</summary>

So a broken deploy fails immediately and visibly, before it takes traffic. The orchestrator keeps the old version running. Lazy failure shows up later, on some requests, as a user-facing outage.
</details>

<details markdown="1">
<summary><code>.env</code> says <code>PORT=4000</code> and the shell has <code>PORT=5000</code>. Which does <code>node --env-file=.env</code> use?</summary>

5000. Node gives the existing environment precedence over the file, which matches the usual rule that the more specific, deploy-time source wins.
</details>

<details markdown="1">
<summary>A database password was pushed to a public repo and you deleted the commit five minutes later. Are you safe?</summary>

No. Scanners watch public pushes and find keys within minutes, and the commit lives on in clones and caches. Revoke the password and issue a new one, then clean the history.
</details>

<details markdown="1">
<summary>Give two reasons some teams avoid putting secrets in environment variables.</summary>

Any two of: child processes inherit them; they are readable via `/proc/<pid>/environ` and `docker inspect`; crash reporters, debug pages and CI steps dump the environment into logs. The alternatives are mounted secret files or fetching from a secret manager at startup.
</details>

<details markdown="1">
<summary>Why does safe rotation need both the old and new credential valid at the same time?</summary>

Instances pick up the new secret one by one during a rollout. If the old one is revoked first, every instance not yet updated fails. The overlap lets the rollout finish, then the old credential is revoked.
</details>

## Go deeper

- [The Twelve-Factor App: Config](https://12factor.net/config): the original argument for strict separation of config from code, and the "could you open-source it now?" test.
- [Node.js CLI: `--env-file`](https://nodejs.org/api/cli.html#--env-filefile): file format, precedence and multiple files, straight from the docs.
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html): rotation, detection, secrets in CI and containers, and what to do after a leak.
- [Martin Fowler: Feature Toggles](https://martinfowler.com/articles/feature-toggles.html): the four kinds of flags and how to keep them from rotting.
- [HashiCorp Vault: Why use Vault](https://developer.hashicorp.com/vault/docs/about-vault/why-use-vault): the problems a secret manager solves, including dynamic short-lived credentials.
- [gitleaks](https://github.com/gitleaks/gitleaks): a scanner for keys in commits and history, with a pre-commit hook. Its README points to Betterleaks, where the same author now does new work.
