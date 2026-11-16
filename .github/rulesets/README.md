# Repository rulesets and settings

Exported copies of the rulesets that protect this repository, so the setup is documented and can be recreated.
Import one in GitHub: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**.

| File | Protects | Rules |
|---|---|---|
| `protect-main.json` | the default branch | no deletion, no force-push, changes arrive by pull request, the code owner must approve, the `test` check must pass, conversations resolved |
| `protect-release-tags.json` | tags `v*` | no deletion, no moving, no force-push |

The repository admin (the owner) can bypass both, so the owner can still push straight to `main`. Everyone else, and bots
such as Dependabot, goes through a pull request that the owner approves (`.github/CODEOWNERS`) and that passes CI. Anyone
who is not invited as a collaborator cannot push at all and can only propose changes from a fork.

## Repository settings to switch on

These live in the GitHub settings, not in a file, so they are listed here to be set once.

| Where | Setting | Why |
|---|---|---|
| Settings → Code security | **Private vulnerability reporting**: on | `SECURITY.md` points reporters here |
| Settings → Code security | **Dependabot alerts** and **security updates**: on | `dependabot.yml` handles routine bumps; this opens fixes for known vulnerabilities at once |
| Settings → Code security | **Secret scanning** and **push protection**: on | blocks a pushed API key before it lands |
| Settings → Code security | **Code scanning**, default setup (CodeQL): on | scans every push to `main` and every pull request |
| Settings → Actions → General | Workflow permissions: **Read repository contents** | the workflow asks for more only where it needs it |
| Settings → Actions → General | Fork pull request workflows: **Require approval for all external contributors** | an outside pull request cannot run workflows until the owner approves |
| Settings → Pages | Source: **GitHub Actions** | publishes the build from `ci.yml` |
| Settings → General → Pull Requests | **Automatically delete head branches**: on | keeps merged branches from piling up |

Not included: "push rules" (blocking `.env` or key files by path). GitHub only offers them to organisation-owned
repositories. Secret scanning with push protection and `.gitignore` cover that here.
