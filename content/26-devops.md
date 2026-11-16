---
title: DevOps for backend engineers
part: Engineering practice
summary: How a commit becomes a running, observed, recoverable service: CI, containers, hosting, rollouts, infrastructure as code, SLOs, incidents and the supply chain.
---

Code on your laptop is worth nothing to a user. Between `git commit` and a request served in production sit a pipeline, an artefact, a registry, a machine, a rollout, a monitor and a person who gets paged. DevOps is the name for owning that whole path. You don't need to become an infrastructure specialist, but a backend engineer who can't ship, observe and roll back their own service is only doing half the job.

## The first principle

Start with how software used to be released. Developers wrote code for months. Then they handed a build to an operations team, who had never seen it, to install on servers the developers had never seen. Releases happened a few times a year, at night, with a checklist and a lot of hope.

The two teams wanted opposite things. Developers were rewarded for change. Operations was rewarded for stability, and change was the main cause of outages, so operations resisted it. Releases got bigger because they were rare, and riskier because they were bigger, which made them rarer still.

The way out is counter-intuitive: **release more often, in smaller pieces**. A change of 50 lines is easy to review, easy to test, and easy to undo. If it breaks something you know exactly where to look. To make small, frequent releases safe you need three things:

1. **Automation**: every step from commit to production runs the same way every time, without a person typing commands.
2. **Fast feedback**: you learn within minutes whether a change broke the build, the tests or production.
3. **Shared ownership**: the people who write the service also deploy it, watch it and fix it. Werner Vogels put it as "you build it, you run it" in 2006.

The word "DevOps" came out of this in 2009. That year John Allspaw and Paul Hammond gave a talk at Velocity titled *10+ Deploys per Day: Dev and Ops Cooperation at Flickr*, and Patrick Debois organised the first DevOpsDays in Ghent. DevOps is not a job title or a tool. It is the set of practices that make change cheap and safe, and the rest of this lesson walks through them in the order a change travels.

## Core ideas

### How it is measured: the DORA metrics

"Are we good at shipping software?" needs numbers, or it becomes an argument. The DORA research programme (DevOps Research and Assessment, started by Nicole Forsgren, Jez Humble and Gene Kim, now part of Google Cloud) surveyed tens of thousands of teams and found a small set of measures that predict both delivery performance and business outcomes. For years they were the "four keys". The 2024 report added a fifth:

| Metric | Question it answers | Group |
|---|---|---|
| Deployment frequency | How often do you deploy to production? | Throughput |
| Change lead time | How long from commit to running in production? | Throughput |
| Failed deployment recovery time | When a deploy breaks something, how fast do you recover? | Throughput |
| Change fail rate | What share of deploys need an immediate fix or rollback? | Instability |
| Deployment rework rate | What share of deploys are unplanned, made to fix a production incident? | Instability |

The most important finding is that **speed and stability are not a trade-off**. The best teams deploy more often *and* break less, because small changes fail less and are easier to recover from. If your team deploys monthly and every deploy is scary, deploying less often makes it worse, not better.

Measure these from your own systems (CI history, deploy logs, incident records), track the trend, and never turn them into individual targets; people will hit the number and miss the point.

### Git branching: trunk-based or git-flow

How you branch decides how big your changes get before they meet everyone else's.

**Git-flow**, described by Vincent Driessen in 2010, uses long-lived `develop` and `main` branches, plus feature, release and hotfix branches. It suits software shipped in numbered versions, such as a desktop app or a library with several supported releases. In 2020 Driessen added a note to his own post: for software that is delivered continuously, such as web apps, he recommends a much simpler workflow instead.

**Trunk-based development** keeps one main branch. Everyone merges small changes into it at least daily, usually through short-lived branches and pull requests that live for hours, not weeks. `main` is always releasable.

| | Git-flow | Trunk-based |
|---|---|---|
| Long-lived branches | `main`, `develop`, release branches | Only `main` |
| Branch lifetime | Days to weeks | Hours to a day or two |
| Merge pain | Large, late, conflict-prone | Small and constant |
| Unfinished features | Wait on a branch | Merged, hidden behind a **feature flag** |
| Fits | Versioned releases | Web services, continuous delivery |

The enabler for trunk-based work is the **feature flag**: code for a half-built feature ships to production switched off, and you switch it on (for staff, then 5% of users, then everyone) without a deploy. This separates *deploying* code from *releasing* a feature. DORA's research links trunk-based development with higher delivery performance.

### Continuous integration: the pipeline

**Continuous integration (CI)** means every change is merged often and checked automatically. A pipeline runs on every push and every pull request:

```
push ─▶ install ─▶ lint ─▶ unit tests ─▶ integration tests ─▶ build image ─▶ push to registry
         (npm ci)   (eslint,   (node:test)  (real Postgres,     (Dockerfile)    (tagged with
                    spectral)               Schemathesis)                        the commit sha)
```

Rules that keep a pipeline useful:

- **Fast.** Under ten minutes, or people stop waiting for it and merge anyway. Cache dependencies, run independent jobs in parallel.
- **Deterministic.** `npm ci` from a lock file, pinned tool versions. A flaky test that fails one run in twenty is worse than no test, because people learn to ignore red builds.
- **Required.** Branch protection on `main`: no merge unless CI is green.
- **Build once.** The image built from a commit is the exact artefact that goes to staging and then production (lesson 23's build stage). Never rebuild for production.

**GitHub Actions** is the CI built into GitHub. A **workflow** is a YAML file in `.github/workflows/`. It runs on **events** (`push`, `pull_request`, a schedule), and contains **jobs**, which run on **runners** (fresh virtual machines, by default) and consist of **steps**: either shell commands (`run:`) or reusable **actions** (`uses:`). Jobs run in parallel unless one `needs` another. You'll write Linkbox's in the build step.

### Secrets in the pipeline, and OIDC to the cloud

The pipeline needs credentials: to push images, to deploy, to run migrations. GitHub stores **secrets** encrypted and exposes them to workflows as `${{ secrets.NAME }}`, masked in logs. Rules:

- Give the workflow's built-in `GITHUB_TOKEN` the least it needs: set `permissions: contents: read` at the top and grant more per job (`packages: write` only on the job that pushes images).
- Secrets aren't passed to workflows triggered from forks. Don't work around this with `pull_request_target` plus a checkout of the fork's code; that hands your secrets to strangers.
- Use **environments** (`environment: production`) to require a reviewer before a job can read production secrets.

The bigger fix is to have no long-lived cloud keys at all. An AWS access key stored as a GitHub secret works forever, from anywhere, for anyone who gets it. With **OpenID Connect (OIDC)**, the workflow asks GitHub for a short-lived signed token that says "I am workflow X in repository Y, running on branch `main`". The cloud provider is configured to trust GitHub's token issuer, checks those claims against a policy, and hands back temporary credentials that expire within the hour.

```yaml
permissions:
  id-token: write        # allow this job to request an OIDC token
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
    with:
      role-to-assume: arn:aws:iam::123456789012:role/linkbox-deploy
      aws-region: eu-west-1
```

On the AWS side, the role's trust policy accepts tokens only when the `sub` claim equals `repo:<owner>/linkbox:ref:refs/heads/main`. Nothing is stored; nothing can leak. Google Cloud, Azure and most other providers support the same flow.

### What a container is

You've been running `docker run postgres` since lesson 01. What is it?

A container is **an ordinary Linux process that the kernel lies to**. There is no "container" object in the Linux kernel. There are three features that, used together, make a process believe it has a machine to itself:

1. **Namespaces** control what a process can *see*. Each namespace type gives the process its own private copy of one global resource:

   | Namespace | Isolates |
   |---|---|
   | `pid` | Process ids: the container's first process is PID 1 and it can't see the host's processes |
   | `net` | Network interfaces, IPs, ports, routing tables |
   | `mnt` | The filesystem tree it sees |
   | `uts` | Hostname |
   | `ipc` | Shared memory and message queues |
   | `user` | User ids: root inside can be an unprivileged user outside |
   | `cgroup`, `time` | Its view of cgroups and of some clocks |

2. **Control groups (cgroups)** control what a process can *use*: CPU time, memory, I/O and number of processes. Exceed a memory limit and the kernel's OOM killer ends the process.

3. **A layered filesystem** gives the process its own root directory, assembled from read-only **image layers** plus one thin writable layer on top (overlayfs). Ten containers from the same image share the same layers on disk.

Because a container is just a process on the host's kernel, it starts in milliseconds and costs almost nothing, unlike a virtual machine, which boots a whole kernel of its own. The price is weaker isolation: every container shares one kernel, so a kernel bug can break out of all of them. Liz Rice's *containers from scratch* program builds one in about 50 lines of Go with exactly these three features. Reading it is the quickest way to see that nothing else is involved.

### Images, layers and the Dockerfile

An **image** is a stack of filesystem layers plus a small JSON config (default command, environment, user, exposed ports). Each instruction in a Dockerfile that changes files creates one layer. Layers are content-addressed by a SHA-256 digest and cached: if an instruction and everything before it are unchanged, Docker reuses the layer.

That cache dictates the order of a good Dockerfile: things that change rarely go first, things that change on every commit go last. Copy `package.json` and the lock file, install dependencies, and only then copy your source. Editing a route no longer reinstalls `node_modules`.

A production Dockerfile for a Node service:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.3-trixie-slim

# Stage 1: install production dependencies. Build tools and the npm cache stay here.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Stage 2: the runtime image. Only what the app needs to run.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
```

What each choice buys you:

- **Multi-stage build.** The first stage can contain compilers, dev dependencies and caches; only the files you `COPY --from` reach the final image. Smaller images pull faster and carry fewer vulnerabilities.
- **Pinned base image.** `node:latest` today and `node:latest` next month are different images, so the same commit builds differently. Pin the exact version; for full reproducibility pin the digest too (`node:24.22.3-trixie-slim@sha256:...`) and let Dependabot or Renovate open pull requests to bump it. Node 26 became the Active LTS line in October 2026, and 24 is in maintenance until April 2028. Either is fine; build on the major version you develop and test with (lesson 23's dev/prod parity).
- **Slim base.** `-slim` drops compilers and docs that a runtime never needs. Alpine is smaller still, but uses musl instead of glibc, which occasionally breaks native modules. Distroless images go further and have no shell at all.
- **Non-root.** The official Node images include a `node` user. If an attacker gets code execution in your app, they are an unprivileged user, not root. Files are copied as root and stay read-only to the app, so it can't modify its own code.
- **Exec-form `CMD`.** `CMD ["node", "src/server.js"]` runs Node directly as PID 1, so it receives `SIGTERM` from the platform (lesson 16). The shell form, `CMD node src/server.js`, wraps it in `/bin/sh`, which may not forward the signal. Note that PID 1 gets no default signal handlers from the kernel, so your app must handle `SIGTERM` itself, or run with `docker run --init`.
- **`.dockerignore`.** Without it, `COPY` sends your local `node_modules`, `.git` and `.env` into the build context and, worse, possibly into the image:

```
node_modules
.git
.env
.env.*
!.env.example
coverage
*.log
```

The same image runs both process types from lesson 23: `node src/server.js` by default, `node src/worker.js` and `node scripts/migrate.js` by overriding the command.

### Registries, runtimes and the OCI

A **registry** stores images and serves them by name and digest: Docker Hub, GitHub Container Registry (`ghcr.io`), Amazon ECR, Google Artifact Registry. A tag like `linkbox:main` is a movable pointer; a digest like `linkbox@sha256:ab12...` names one exact image forever. Deploy by digest (or by an immutable tag such as the commit SHA), so that what you tested is what you run.

None of this is Docker-specific any more. The **Open Container Initiative (OCI)**, founded in 2015, standardised the image format, the runtime and the distribution protocol. Docker, Podman, BuildKit, containerd and Kubernetes all speak OCI. Underneath, the low-level runtime that actually creates the namespaces and cgroups is usually **runc**, the OCI reference implementation.

**Scan images before you ship them.** Your image contains hundreds of OS packages and npm modules you never chose directly. Scanners such as **Trivy**, Grype or Docker Scout compare them against vulnerability databases. Run one in CI and fail the build on critical findings that have a fix available. `dive` shows what each layer adds, which is how you find the 300 MB you didn't mean to ship.

### Running it on one machine: systemd, TLS, Kamal

You don't need Kubernetes to run a backend. One virtual machine with 2–4 CPUs handles far more traffic than most products ever see. On one machine you need three things: something to keep the process running, something to terminate TLS, and a way to deploy without downtime.

**systemd** is the init system on almost every Linux server. It starts processes at boot, restarts them when they crash, sends `SIGTERM` on stop and captures stdout into the journal (`journalctl -u linkbox-web`), exactly the process manager twelve-factor asks for:

```ini
# /etc/systemd/system/linkbox-web.service
[Unit]
Description=Linkbox web
After=network-online.target
Wants=network-online.target

[Service]
User=linkbox
WorkingDirectory=/srv/linkbox
EnvironmentFile=/etc/linkbox/env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

**Caddy** is a web server and reverse proxy that obtains and renews TLS certificates on its own, using the ACME protocol with Let's Encrypt or ZeroSSL, and redirects HTTP to HTTPS. This is a complete config:

```
linkbox.example.com {
	reverse_proxy localhost:3000
}
```

**Kamal**, from 37signals, packages this whole pattern. It builds your image, pushes it to a registry, SSHes into your servers, starts the new container next to the old one, waits for its health check through `kamal-proxy`, switches traffic over, and stops the old one. Zero-downtime deploys and automatic TLS, configured in one file:

```yaml
# config/deploy.yml
service: linkbox
image: you/linkbox
servers:
  web:
    - 203.0.113.10
  worker:
    hosts:
      - 203.0.113.10
    cmd: node src/worker.js
proxy:
  ssl: true
  host: linkbox.example.com
  app_port: 3000
  healthcheck:
    path: /health/ready
registry:
  server: ghcr.io
  username: you
  password:
    - KAMAL_REGISTRY_PASSWORD
builder:
  arch: amd64
env:
  secret:
    - DATABASE_URL
    - REDIS_URL
    - SESSION_SECRET
```

`kamal setup` prepares a fresh server; `kamal deploy` ships; `kamal rollback <version>` goes back. The limit of one machine is the machine: if it dies, you're down until you replace it. Two machines behind a load balancer fix most of that.

### Kubernetes: the cluster and the control loop

When you run many services across many machines, someone has to decide which container runs where, restart it when a machine dies, and route traffic to wherever it ended up. **Kubernetes** does that.

A cluster has a **control plane** (the API server, the `etcd` database that stores all state, a scheduler and controllers) and **worker nodes**, each running a `kubelet` agent and a container runtime. You never tell Kubernetes "start a container on node 3". You tell it what you want to exist, and it makes reality match.

That is the **control loop**, the one idea behind all of Kubernetes:

```
loop forever:
  desired = what the stored objects say   ("3 replicas of linkbox-web, image v42")
  actual  = what is really running         ("2 replicas, one node just died")
  if actual != desired: act to close the gap  ("start one more on a healthy node")
```

Every controller runs this loop for its own kind of object. You change the desired state; the loops do the work. That's why Kubernetes heals itself, and why it can feel slow and indirect.

The objects you meet first:

- **Pod**: one or more containers scheduled together, sharing a network address. The unit Kubernetes runs. Pods are disposable; they are replaced, never repaired.
- **Deployment**: "keep N identical pods of this template running", and roll them over to a new template gradually when you change it.
- **Service**: a stable name and virtual IP that load-balances across the pods matching a label, whichever nodes they're on.
- **Job**: run a pod to completion once, which is how you run migrations (lesson 23's admin process).
- **ConfigMap** and **Secret**: configuration and credentials, injected as environment variables or files.

A Deployment for Linkbox's web process:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linkbox-web
spec:
  replicas: 3
  selector:
    matchLabels: { app: linkbox-web }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  template:
    metadata:
      labels: { app: linkbox-web }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: web
          image: ghcr.io/you/linkbox:sha-3f2a9c1
          ports: [{ containerPort: 3000 }]
          envFrom: [{ secretRef: { name: linkbox-env } }]
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { memory: 512Mi }
          startupProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 1
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
            periodSeconds: 5
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
```

The three **probes** map onto the endpoints from lesson 16:

| Probe | Question | On failure |
|---|---|---|
| Startup | Has it finished booting? | Keep waiting (up to the threshold), then restart. Other probes wait for it |
| Liveness | Is the process stuck beyond repair? | Restart the container |
| Readiness | Should it receive traffic right now? | Remove from the Service; don't restart |

Keep liveness cheap and local: never check the database in a liveness probe, or a database blip restarts every pod at once. The `preStop` sleep gives load balancers a few seconds to stop sending traffic before `SIGTERM` arrives (the `sleep` action needs Kubernetes 1.30 or newer). `k9s` is a terminal UI that makes all of this much easier to watch.

### The ladder of hosting

Kubernetes is one rung on a ladder. Climb only as far as you need:

| Rung | Examples | You manage | Good until |
|---|---|---|---|
| Platform as a service | Render, Fly.io, Railway, Heroku | Your code and config | Cost or a missing feature |
| One or two VMs | systemd, Caddy, Kamal | OS, patches, backups | You need many machines or fast failover |
| Managed containers | Cloud Run, ECS on Fargate, Azure Container Apps | Images and service config | Complex networking or many services |
| Managed Kubernetes | EKS, GKE, AKS | Manifests, cluster upgrades, add-ons | Rarely outgrown; the cost is people's time |

Everything in this course is twelve-factor, so Linkbox can move up or down the ladder without code changes. That is the point of lesson 23.

One note on the first rung: Heroku still runs and is supported, but since February 2026 it gets no new features, so start a new project on one of the others.

### Shipping a change safely: rolling, blue-green, canary

Deploying replaces old processes with new ones. How you replace them decides how much a bad release can hurt.

- **Rolling update.** Replace instances a few at a time; each new one must pass readiness before the next old one stops. The default in Kubernetes and Kamal. Cheap, but for a while old and new versions serve traffic side by side, which is why database changes must be backwards-compatible (expand and contract, lesson 23).
- **Blue-green.** Run the full new version ("green") next to the old one ("blue"), test it, then switch all traffic in one step at the load balancer. Rollback is switching back. It needs double the capacity during the switch.
- **Canary.** Send a small share of real traffic (1%, then 5%, 25%, 100%) to the new version, and compare its error rate and latency with the old one before each step. Tools like Argo Rollouts and Flagger automate the analysis and roll back on their own if the canary is worse.

All three depend on two things you already built: **health checks** that tell the truth, and **metrics** (lesson 15) good enough to see that the new version is worse. Feature flags add a fourth option: deploy the code dark and release the behaviour separately.

### GitOps and Argo CD

In the pipeline above, CI pushes changes into the cluster (`kubectl apply` from a CI job). That means CI holds cluster credentials, and nobody can say for sure what is running without asking the cluster.

**GitOps** turns this around. The desired state of every environment lives in a Git repository as declarative files. An agent inside the cluster, such as **Argo CD** or Flux, continuously *pulls* that repository and reconciles the cluster to match: the control loop again, with Git as the source of desired state. Deploying means merging a pull request that changes an image tag. Rolling back means reverting a commit. Every change has an author, a review and a history. If someone edits the cluster by hand, the agent notices the drift and puts it back.

### Infrastructure as code: Terraform, state, drift

The servers, databases, buckets, DNS records and IAM roles underneath your service are also configuration, and clicking them together in a web console doesn't scale or repeat. **Infrastructure as code** describes them in files, reviewed and versioned like application code. **Terraform** (and OpenTofu, its open-source fork created after HashiCorp moved Terraform to the Business Source Licence in 2023) is the most common tool:

```hcl
terraform {
  required_version = ">= 1.11"
  backend "s3" {
    bucket       = "linkbox-tfstate"
    key          = "prod/terraform.tfstate"
    region       = "eu-west-1"
    use_lockfile = true
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "linkbox-attachments-prod"
}
```

`terraform plan` shows what would change; `terraform apply` does it. To know what "change" means, Terraform keeps a **state file** that maps each resource in your code to the real object it created (this bucket block ↔ that bucket's ARN). State is critical and sensitive:

- Keep it in a **remote backend** (an S3 bucket, HCP Terraform), never on a laptop, and **lock** it so two applies can't run at once.
- It can contain secrets in plain text, such as generated database passwords. Restrict and encrypt it.
- Losing it means Terraform no longer knows it owns your infrastructure.

**Drift** is the gap between the code and reality, usually because someone changed something by hand in the console. `terraform plan` reveals it; run plans on a schedule in CI to catch drift early, and then either fix reality or update the code. The rule that prevents most drift is simple: once a resource is in code, nobody changes it any other way.

### Keeping it up: SLOs and on-call

"Is the service healthy?" needs a definition that users would agree with.

- An **SLI** (service level indicator) is a measurement of user experience: the share of requests that succeed, or the share served in under 300 ms.
- An **SLO** (objective) is a target for an SLI over a window: "99.9% of `GET /bookmarks` requests succeed, over 30 days".
- An **SLA** is a contract with penalties, and should be looser than your SLO.

The SLO's complement is the **error budget**. 99.9% over 30 days allows 0.1% failure, about 43 minutes of full downtime or its equivalent in failed requests. While budget remains, ship freely. When it's spent, slow down and spend the time on reliability. The budget turns "should we ship or stabilise?" from an argument into arithmetic. And 100% is never the target: it's impossible, and every extra nine costs roughly ten times more.

**Alert on the SLO, not on causes.** "CPU at 90%" is not a reason to wake someone; users might be fine. "We're burning error budget 14 times faster than sustainable" is. Google's SRE workbook recommends burn-rate alerts over two windows (for example, a page when 2% of the monthly budget burns within an hour). Every page must be urgent, actionable and need a human. Anything else is a ticket for the morning.

**On-call** is the rotation of engineers who answer those pages. Make it humane: a primary and a secondary, handovers, a runbook linked from every alert, and a review of noisy alerts every week. A team that is paged ten times a night stops reading pages.

### Incidents and blameless postmortems

Something will break. An **incident** process makes the response calm and quick:

1. **Declare it** early, with a severity level. It's cheaper to downgrade than to start late.
2. **Assign roles**: an incident commander who coordinates and decides, someone who communicates with users and the company, and people who investigate.
3. **Mitigate first, diagnose later.** Roll back, flip the flag, fail over, add capacity. Understanding the root cause can wait until users are fine.
4. **Communicate** on a fixed rhythm, on a status page and in one channel, even when the update is "still investigating".

Afterwards, write a **postmortem**: what happened, the timeline, the impact, the contributing causes and the action items, each with an owner. It must be **blameless**. If people are punished for honest mistakes, they hide them, and you lose the information you need. "An engineer ran the wrong command" is never a root cause; the question is why the system let one command do that much damage. John Allspaw's 2012 post on blameless postmortems at Etsy and Google's SRE book are the classic statements of this.

Cloudflare's public postmortem of its 18 November 2025 outage is worth reading as a model. A database permissions change made a query return duplicate rows, which roughly doubled the size of a configuration file for bot detection. The file was pushed to the whole network, exceeded a hard limit in the core proxy, and made it fail with HTTP 5xx errors; full recovery took about six hours. No one made a dramatic mistake. A reasonable change in one system met an unchecked assumption in another. Among the fixes: treat internally generated configuration with the same suspicion as user input, and add more global kill switches.

### Trusting what you ship: the supply chain

Your image runs code from hundreds of people you have never met: npm packages, OS packages, base images, GitHub Actions, compilers. Each one is a way in. This is the **software supply chain**, and attackers have learned that compromising one popular dependency is easier than attacking thousands of companies.

The clearest example is the **xz backdoor** (CVE-2024-3094). Over about two years, an account called "Jia Tan" earned the trust of the overworked solo maintainer of `xz`, a compression library present on nearly every Linux system, and became a co-maintainer. Versions 5.6.0 and 5.6.1 shipped a backdoor hidden in test files and in release tarballs (not in the Git repository), which, on distributions that link `sshd` to `liblzma` through systemd, would have let the attacker run code on servers over SSH. On 29 March 2024 Andres Freund, a PostgreSQL developer at Microsoft, noticed SSH logins using more CPU than they should and taking about half a second longer, dug in, and reported it to the `oss-security` list. It was caught in testing and pre-release distributions, before it reached most stable ones.

Closer to your pipeline: in March 2025 the popular `tj-actions/changed-files` GitHub Action was compromised. Its version tags were rewritten to point at a malicious commit that printed CI secrets into workflow logs, and every workflow that referenced it by tag ran the new code.

A year later it happened to a security tool. On 19 March 2026 an attacker with stolen credentials moved 76 of the 77 version tags of `aquasecurity/trivy-action`, the official action for the Trivy scanner mentioned above, to code that stole CI secrets, and published a malicious Trivy release (v0.69.4). The tags were bad for about twelve hours. Workflows that pinned the action to a commit SHA kept running the code they had reviewed.

Packages are attacked the same way. In September 2025 a self-replicating worm known as *Shai-Hulud* spread through more than 500 npm packages. Its install script stole the tokens it found on each machine and used them to publish infected versions of that developer's own packages.

Defences that are cheap and effective:

- **Lock and verify dependencies.** Commit the lock file, install with `npm ci`, review dependency diffs in pull requests, and keep updates flowing through Dependabot or Renovate so you're never years behind.
- **Let new releases age.** Most malicious versions are found and removed within days, so a waiting period keeps them out. `min-release-age=7` in `.npmrc` (npm 11.10 or newer) makes npm skip any version published in the last seven days. Dependabot has the same idea under the name `cooldown`.
- **Pin actions by commit SHA.** A tag can be moved; a commit SHA can't. `uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0`.
- **Least privilege everywhere.** Read-only `GITHUB_TOKEN` by default, OIDC instead of long-lived keys, non-root containers, small base images.
- **Scan and record.** Scan images in CI; generate an **SBOM** (a list of everything inside the image) with Syft or Trivy so you can answer "are we affected?" in minutes when the next CVE lands.
- **Prove provenance.** Sign images (Sigstore's `cosign`) and attach build provenance (GitHub's artifact attestations, the SLSA framework), so production can refuse images that didn't come from your pipeline.

### The whole picture, end to end

```
 developer ── small PR ──▶ GitHub ── CI: lint, test, contract, build, scan ──▶ image@sha256 in registry
                                                                                    │
     Terraform: VMs, DB, buckets, DNS, IAM (state locked, drift checked)            │
                                                                                    ▼
 GitOps repo / Kamal config ──▶ rollout (rolling, blue-green, canary) ──▶ processes (web ×3, worker ×2)
                                         ▲                                          │
                                         │ rollback                                 ▼ logs, metrics, traces
                                    incident ◀── page ◀── SLO burn-rate alert ◀── observability (lesson 15)
                                         │
                                         ▼
                                blameless postmortem ──▶ action items ──▶ small PRs
```

Every arrow is automated except the ones that need judgement: reviewing the change, deciding to roll back, and learning from what went wrong.

## Try it

You need Docker. On Linux you can also try the namespace experiments directly.

**1. Look inside the kernel's lies (Linux, or inside a Linux VM).**

```bash
# A new PID, UTS and mount namespace: you are PID 1 with your own hostname.
sudo unshare --pid --fork --mount-proc --uts bash
hostname box && hostname
ps aux                       # only two processes
exit
```

**2. Hit a cgroup limit.**

```bash
docker run --rm --name hog --memory=64m node:24.22.3-trixie-slim \
  node -e 'const a = []; for (;;) a.push(Buffer.alloc(1e6, 1))'
echo "exit code: $?"         # 137 = 128 + SIGKILL: the OOM killer
```

**3. Build an image and look at its layers.** In Linkbox, with the Dockerfile above:

```bash
docker build -t linkbox:dev .
docker image ls linkbox:dev                 # size
docker history linkbox:dev                  # one line per layer
docker run --rm linkbox:dev id              # uid=1000(node), not root
dive linkbox:dev                            # if installed: what each layer adds
trivy image linkbox:dev                     # if installed: known vulnerabilities
```

Change one line in `src/` and build again. Which steps say `CACHED`?

**4. Watch a graceful stop.** `docker run -d --name web -p 3000:3000 --env-file .env linkbox:dev`, then `docker stop web` and read `docker logs web`. You should see your `SIGTERM` handler's log lines from lesson 16. `docker stop` sends `SIGTERM`, waits 10 seconds by default, then sends `SIGKILL`.

Break it on purpose:

1. Change `CMD` to shell form, `CMD node src/server.js`, rebuild, and `docker stop` again. Does your shutdown log still appear? How long does the stop take?
2. Move `COPY src ./src` above `RUN npm ci`. Change a source file and rebuild. How long does it take now, and why?
3. Delete `.dockerignore`, create a `.env` with a fake secret, rebuild, and run `docker run --rm linkbox:dev ls -a`. Is your secret in the image?
4. Remove `USER node` and run `docker run --rm linkbox:dev id`. What could an attacker who finds a remote-code-execution bug do now that they couldn't before?

## Common mistakes

- **Building a new image per environment.** Rebuilding for production means production runs something you never tested. Build once per commit, promote the same digest through every environment, and vary only config.
- **Long-lived cloud keys in CI secrets.** They work from anywhere, forever, for whoever leaks them. Use OIDC and short-lived credentials.
- **Liveness probes that check dependencies.** A slow database makes every pod fail liveness and Kubernetes restarts them all, turning a blip into an outage. Liveness checks the process; readiness checks dependencies.
- **Changing infrastructure by hand "just this once".** The next `terraform apply` silently reverts it, or the state no longer matches reality. Every change goes through code.
- **Alerting on causes instead of symptoms.** Pages for high CPU or one failed health check train people to ignore pages. Alert on SLO burn; send the rest to dashboards and tickets.
- **Referencing third-party actions and images by movable tags.** A compromised tag runs new code in your pipeline with your secrets. Pin by SHA or digest, and let a bot propose updates.

## Build: Linkbox, step 26

Package Linkbox as an image, run the whole system with one command, and make every push prove itself.

1. Add the multi-stage `Dockerfile` and the `.dockerignore` from above. Build it and confirm `docker run --rm linkbox:dev id` shows the `node` user.

2. Add `compose.yaml` that runs the full formation from lesson 23, including the one-off migration, using the same image for all three app processes:

```yaml
services:
  postgres:
    image: postgres:18
    environment: { POSTGRES_USER: linkbox, POSTGRES_PASSWORD: linkbox, POSTGRES_DB: linkbox }
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U linkbox"]
      interval: 2s
      retries: 30
  redis:
    image: redis:8
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      retries: 30
  migrate:
    build: .
    command: ["node", "scripts/migrate.js"]
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
  web:
    build: .
    env_file: .env
    ports: ["3000:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 5s
      retries: 10
  worker:
    build: .
    command: ["node", "src/worker.js"]
    env_file: .env
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
volumes:
  pgdata:
```

   Add the S3-compatible storage server from lesson 20 the same way. In `.env.example`, point `DATABASE_URL` and `REDIS_URL` at the service names (`postgres`, `redis`), not `localhost`. `docker compose up -d --build` should bring everything up, with `web` reporting healthy in `docker compose ps`.

3. Write `scripts/contract-test.sh`: sign up a throwaway user with `curl`, log in, extract the session cookie, and run Schemathesis against `http://localhost:3000/api/v1` with that cookie (lesson 24).

4. Add `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run lint:api
      - run: npm test                 # Testcontainers starts Postgres and Redis (lesson 22)

  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: cp .env.example .env
      - run: docker compose up -d --build
      - run: curl -sf --retry 30 --retry-delay 2 --retry-all-errors localhost:3000/health/ready
      - uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3
      - run: ./scripts/contract-test.sh
      - if: failure()
        run: docker compose logs

  image:
    needs: [test, contract]
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      - uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
        with:
          images: ghcr.io/${{ github.repository }}
          tags: type=sha,format=long
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

5. Protect `main` on GitHub: require the `test` and `contract` checks to pass before merging.
6. Deploy. Pick one rung of the ladder: a PaaS that pulls `ghcr.io/<you>/linkbox` (set its health check path to `/health/ready`), or a small VM with Kamal and the `config/deploy.yml` above. Either way: run the migration once per release as a one-off command, run `web` and `worker` from the same image, and keep secrets in the platform, not in the repository.
7. Write `docs/runbook.md`: how to deploy, how to roll back to the previous image, where the logs and metrics are, and one SLO for Linkbox (for example, 99.5% of API requests succeed over 30 days).

**Done when** a pull request runs lint, tests and the contract check automatically; merging to `main` produces an image tagged with the commit SHA in GHCR; that image runs as a non-root user, passes its readiness check in production, and you have rolled back to the previous version once on purpose.

## Check yourself

<details markdown="1">
<summary>Name the five DORA metrics. Why does DORA say speed and stability are not a trade-off?</summary>

Deployment frequency, change lead time, failed deployment recovery time, change fail rate and deployment rework rate. The best teams score well on all of them at once, because small, frequent changes fail less often and are easier to diagnose and undo.
</details>

<details markdown="1">
<summary>A container is "just a process". What three kernel features make it look like a separate machine?</summary>

Namespaces limit what it can see (processes, network, mounts, hostname, users), cgroups limit what it can use (CPU, memory, I/O), and a layered filesystem gives it its own root directory built from image layers.
</details>

<details markdown="1">
<summary>Why does OIDC from GitHub Actions to the cloud beat storing an access key as a secret?</summary>

There is no long-lived credential to leak. Each run gets a short-lived token whose claims (repository, branch) the cloud checks against a policy before issuing temporary credentials that expire within the hour.
</details>

<details markdown="1">
<summary>What is the difference between a liveness and a readiness probe, and which one should check the database?</summary>

Liveness asks "is this process stuck beyond repair?" and failure restarts the container. Readiness asks "should it get traffic now?" and failure only takes it out of the load balancer. Dependencies like the database belong in readiness; checking them in liveness can restart every pod during a database blip.
</details>

<details markdown="1">
<summary>What does Terraform's state file do, and what is drift?</summary>

State maps each resource in your code to the real object it manages, so Terraform can work out what to create, change or delete. Drift is when reality no longer matches the code, usually from manual changes; `terraform plan` reveals it.
</details>

<details markdown="1">
<summary>Your SLO is 99.9% success over 30 days. Roughly how much downtime does the error budget allow, and what do you do when it is spent?</summary>

About 43 minutes (0.1% of 30 days). When it's spent, you slow down feature releases and spend the effort on reliability until the budget recovers.
</details>

## Go deeper

- [DORA's software delivery metrics](https://dora.dev/guides/dora-metrics/): the five metrics, how to measure them, and how they evolved from the four keys.
- [Liz Rice: containers from scratch](https://github.com/lizrice/containers-from-scratch): a container built from namespaces and cgroups in a few dozen lines of Go.
- [Docker: Building best practices](https://docs.docker.com/build/building/best-practices/): multi-stage builds, caching, pinning base images and `.dockerignore`, from the source.
- [GitHub: OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect): how workflows get short-lived cloud credentials without stored secrets.
- [Google SRE book: Postmortem culture](https://sre.google/sre-book/postmortem-culture/): how to write blameless postmortems, and why they matter. The [SRE workbook chapter on SLOs](https://sre.google/workbook/implementing-slos/) covers error budgets and burn-rate alerts.
- [Andres Freund: backdoor in upstream xz/liblzma](https://www.openwall.com/lists/oss-security/2024/03/29/4): the original report, a short read that shows how the backdoor was found.
