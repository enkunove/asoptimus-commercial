# ci — GitHub Actions

The ASOptimus code lives in **separate submodule repos** (`asoptimus-server`,
`asoptimus-client`), so each workflow belongs in that repo's
`.github/workflows/`. GitHub only runs workflows from `.github/workflows/`, not
from `infra/ci/`, so these are the canonical definitions kept in the
superproject; **copy each into the repo named below** to activate it.

| File | Copy into | Does |
|---|---|---|
| `server-ci.yml` | `asoptimus-server/.github/workflows/` | `bun test`, then build + push the server image to GHCR |
| `client-release.yml` | `asoptimus-client/.github/workflows/` | `bun test`, build the 4 `bun --compile` binaries, and on macOS sign + notarize a `.dmg` (§9) |

Both repos embed `shared` as a nested submodule, so every checkout uses
`submodules: recursive`.

## server-ci.yml → GHCR

- On push to `main` and version tags. Runs `bun test`, then builds
  `server/Dockerfile` and pushes to `ghcr.io/enkunove/asoptimus-server`
  (tags: `latest`, the branch/tag, and the commit SHA).
- Auth uses the built-in `GITHUB_TOKEN` (needs `packages: write`, already set in
  the workflow `permissions`). No extra secret required.
- To pull the image on your host: make the GHCR package public, or
  `docker login ghcr.io -u <you>` with a PAT that has `read:packages`.

## client-release.yml → binaries + signed .dmg

- On version tags (`v*`) / manual dispatch. Job `binaries` (Ubuntu) cross-builds
  all four targets with `bun build --compile` and uploads them to the GitHub
  Release. Job `macos-dmg` (macOS runner) signs the macOS arm64 binary with the
  Developer ID cert, wraps it in a `.dmg`, and notarizes + staples it (§9:
  macOS-only signed `.dmg`).
- **Repo secrets required for the notarization job** (Apple Developer, $99/yr —
  the cert is added at the very end, per §9):

  | Secret | What |
  |---|---|
  | `APPLE_CERTIFICATE_BASE64` | Developer ID Application cert, `.p12`, base64-encoded |
  | `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
  | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
  | `APPLE_ID` | Apple ID email used for notarization |
  | `APPLE_APP_PASSWORD` | app-specific password for that Apple ID |
  | `APPLE_TEAM_ID` | 10-char Apple Developer Team ID |
  | `KEYCHAIN_PASSWORD` | any string; unlocks the ephemeral CI keychain |

  Without these the `macos-dmg` job is skipped (the `binaries` job still ships
  unsigned artifacts). The Phase-2 Tauri `.dmg` swaps into the same job once
  `client/src-tauri/` exists (see the commented block in the workflow).
