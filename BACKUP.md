# Backups

Crate keeps three copies of itself so it survives if GitHub goes away.

1. **Second git home** (`.github/workflows/backup.yml`). After every sync, every
   push and once a night, the whole repo is pushed to a second host: every branch,
   the full history and all synced data (`data/`, value history, sound profiles).
   Pull request and issue history goes to a `github-history` branch there.
   It's off until the `BACKUP_REPO_URL` secret is set:
   `https://oauth2:<token>@gitlab.com/<user>/discogs-crate.git`
   (GitLab project access token, role Maintainer, scope `write_repository`).
   GitLab caps tokens at one year, so renew it before it expires.
2. **Offline bundle** – one file holding the whole repo:
   `git bundle create crate.bundle --all`. Restore with `git clone crate.bundle discogs-crate`.
3. **Your browser data** – mixes, ratings, manual BPM/key edits and settings live in
   the browser unless a GitHub token is set in Settings (then they're in `user/state.json`).
   Settings › Download backup saves them; Restore backup loads them.

Not in git, so keep them somewhere safe yourself: the `DISCOGS_TOKEN` secret
(make a new one at discogs.com/settings/developers) and your Spotify Client ID
(developer.spotify.com/dashboard).
