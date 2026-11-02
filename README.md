# Crate

A web app for browsing a Discogs record collection and planning mixes to play on real vinyl.

- **Records**: cover grid with filters for genre, style, label, decade and folder, sortable by date added, artist, year, label/catalogue number or rating.
- **Tracks**: every track in the collection, sortable and filterable by BPM, key (Camelot), genre and style. "Mixes with" shows tracks whose key sits well with a chosen key.
- **Mixes**: build ordered playlists from tracks you own. Every step shows how far to pitch the next record and whether the keys work, including the key shift that pitching causes on vinyl (no key lock on a turntable). Lists the records to pull and the side/position of each track, suggests what could come next, and can auto-order a mix.
- **Edits**: BPM and key are estimates; type over any value to correct it.
- **Blend**: plays a mix (in Generate or My mixes) from the 30-second previews like a DJ set. Crate finds each preview's beat grid in the browser (`site/beats.js`), pitches the next track so the beats line up (vinyl-style, so the key moves too), drops it in on a beat with the bass cut, swaps the basses halfway through a 16-beat blend, then eases the new track back to its own tempo. If a preview can't be analysed it still tempo-matches and crossfades.
- **Decks**: turn the phone sideways on Tracks, Generate or My mixes (or tap Decks) for two turntables and a mixer playing the 30-second previews (`site/decks.js`). Each deck has a platter (drag to nudge a playing record or wind a stopped one), cue, play, a pitch fader (minus at the top, like a Technics) and Sync, which matches tempo (half/double time too) and drops the beats in line; the mixer has two channel faders and a crossfader. The picker lists the open mix, or tracks sorted by how well they fit the other deck.
- **Spotify Mix**: with Spotify connected, "Save as Spotify playlist" puts the mix in your account as a private playlist; open it in the Spotify app and tap **Mix** for Spotify's own transitions (Premium; they don't play over Spotify Connect, so not when Crate drives Spotify).
- **Snippets**: ▶ plays a quick 30-second preview (Deezer, else Apple Music) to recognise a track; the YouTube button plays the full video linked on Discogs, or searches YouTube when there isn't one.

## How it stays up to date

A GitHub Actions workflow (`.github/workflows/sync.yml`) runs twice an hour, and `deploy.yml` publishes the site after each sync and after every code change:

1. `sync/sync_discogs.py` reads the collection from the Discogs API and fetches tracklists for records it hasn't seen before. Removed records drop out.
2. `sync/enrich.py` looks up BPM and key for new tracks: AcousticBrainz first (via a MusicBrainz match), then a local Essentia analysis of Deezer's 30-second preview. It stops after 40 minutes and continues on the next run, so the first full pass over a large collection takes a few runs.
3. `sync/build.py` writes `site/data.json`, and the `site/` folder is published to GitHub Pages.

Synced data is committed to `data/` so each run only does new work. Run it by hand from the Actions tab with "Run workflow".

### Accuracy

- AcousticBrainz stopped collecting in 2022 and mostly covers releases that people ripped digitally, so many vinyl-only tracks won't be there.
- Preview analysis covers 30 seconds of what Deezer thinks is the track. Tempo is usually right but can come out at half or double. Key is right roughly 70% of the time. It may match a different mix than the one on your record.
- Tracks with no match are retried after 30 days.

## Setup

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Optional, only if the Discogs collection is private: create a token at Discogs **Settings → Developers → Generate new token** and add it as the repository secret `DISCOGS_TOKEN` (**Settings → Secrets and variables → Actions**). A token also doubles the API rate limit.
3. Optional, to sync your edits and mixes across devices: create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) limited to this repository with **Contents: read and write**, then paste it in the app under Settings. Without it, edits and mixes stay in the browser you made them in (use Download backup to move them).

To use a different Discogs account, set the repository variable `DISCOGS_USERNAME`.

## Running locally

```sh
pip install -r sync/requirements.txt
python sync/sync_discogs.py && python sync/enrich.py && python sync/build.py
python -m http.server -d site 8000
```
