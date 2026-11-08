# Crate

A web app for browsing a Discogs record collection and planning mixes to play on real vinyl.

- **Records**: cover grid with filters for genre, style, label, decade and folder, sortable by date added, artist, year, label/catalogue number or rating.
- **Tracks**: every track in the collection, sortable and filterable by BPM, key (Camelot), genre and style. "Mixes with" shows tracks whose key sits well with a chosen key.
- **Mixes**: build ordered playlists from tracks you own. Every step shows how far to pitch the next record and whether the keys work, including the key shift that pitching causes on vinyl (no key lock on a turntable). Lists the records to pull and the side/position of each track, suggests what could come next, and can auto-order a mix.
- **Edits**: BPM and key are estimates; type over any value to correct it.
- **Blend**: plays a mix (in Generate or My mixes) from the 30-second previews like a DJ set. Crate finds each preview's beat grid in the browser (`site/beats.js`), pitches the next track so the beats line up (vinyl-style, so the key moves too), drops it in on a beat with the bass cut, swaps the basses halfway through a 16-beat blend, then eases the new track back to its own tempo. If a preview can't be analysed it still tempo-matches and crossfades.
- **Blend the videos**: plays the mix as full songs from the YouTube videos linked on Discogs, starting the next video near the end of each song and crossfading over 10 seconds. YouTube's player can't change tempo finely or expose the sound, so this isn't beatmatched. iPhones don't let a page set a video's volume, so there it goes straight on to the next song. Tracks without a linked video are left out.
- **View switcher**: Records and Tracks share one List · Crate · Decks switcher at the top (also inside Crate and Decks). Tapping one switches straight away and is remembered, so turning the phone sideways on either page opens that view. Crate on Tracks flicks through the records the listed tracks are on.
- **Decks**: pick Decks in the switcher on Records or Tracks, or turn the phone sideways on Generate or My mixes (or tap Decks there) for two turntables and a mixer playing the 30-second previews (`site/decks.js`). Each deck has a platter (drag to nudge a playing record or wind a stopped one), cue, play, a pitch fader (minus at the top, like a Technics) and Sync, which matches tempo (half/double time too) and drops the beats in line; the mixer has two channel faders and a crossfader. The picker lists the open mix, or tracks sorted by how well they fit the other deck.
- **Spotify Mix**: with Spotify connected, "Save as Spotify playlist" puts the mix in your account as a private playlist; open it in the Spotify app and tap **Mix** for Spotify's own transitions (Premium; they don't play over Spotify Connect, so not when Crate drives Spotify).
- **Value**: the collection as a portfolio. Today's value (Discogs' own minimum / median / maximum with a token, else the sum of each record's price), the change over the past month, quarter, year or all time, a graph you can scrub, the average per record, a breakdown by genre, style, label or decade (tap a genre for its own line), leaderboards of the biggest gainers, biggest losers and most valuable records (top 5, expandable to 10, 25 or all; by amount or by %), and every record sorted by value, gain, loss or fewest for sale. Each record page shows its typical price, range, copies for sale and prices by condition. Discogs keeps no price history, so Crate saves a snapshot every day (`sync/value.py`, `data/value/`) and the graph starts from the first one.
- **Snippets**: ▶ plays a quick 30-second preview (Deezer, else Apple Music) to recognise a track; the YouTube button plays the full video linked on Discogs, or searches YouTube when there isn't one.

## How it stays up to date

A GitHub Actions workflow (`.github/workflows/sync.yml`) runs twice an hour, and `deploy.yml` publishes the site after each sync and after every code change:

1. `sync/sync_discogs.py` reads the collection from the Discogs API and fetches tracklists for records it hasn't seen before. Removed records drop out.
2. `sync/enrich.py` looks up BPM and key for new tracks: AcousticBrainz first (via a MusicBrainz match), then a local Essentia analysis of Deezer's 30-second preview. It stops after 40 minutes and continues on the next run, so the first full pass over a large collection takes a few runs.
3. `sync/value.py` prices the records not checked in the last day on the Discogs marketplace (8 minutes per run, so every record is checked about daily) and saves one value snapshot per day to `data/value/history.json`.
4. `sync/build.py` writes `site/data.json` and `site/value.json`, and the `site/` folder is published to GitHub Pages.

Synced data is committed to `data/` so each run only does new work. Run it by hand from the Actions tab with "Run workflow".

- **Match score**: the % on every transition (and on "What could come next", Swap and the generator's Min. match) is the chance the next track works after this one on your decks, from `site/match.js`. Parts: tempo (how far the pitch fader moves), key once pitched, *tuning* (vinyl has no key lock, so 3% of pitch leaves a track half a semitone off any key), sound profile, Discogs styles and label, energy, half/double time, and whether BPM/key were only estimated from a preview. Release year isn't used. It's a small logistic model in log space, so one bad part pulls the score down instead of being averaged away.
- **Rating loop**: Settings › Match score › **Rate transitions** plays you pairs (blend them with the previews) and asks *works / just about / doesn't work*, with Crate's own % hidden until you answer. Pairs come from your own mixes and from whichever score band has the fewest ratings, so every percentage gets checked. 👍/👎 on transitions count too. From 20 verdicts on, the model refits its weights on them in the browser (pulled toward the defaults so a few ratings can't overturn it), and the card shows how the % has held up: "said 80–90%, worked 83%", checked on ratings the model didn't learn from.

### Accuracy

- AcousticBrainz stopped collecting in 2022 and mostly covers releases that people ripped digitally, so many vinyl-only tracks won't be there.
- Preview analysis covers 30 seconds of what Deezer thinks is the track. Tempo is usually right but can come out at half or double. Key is right roughly 70% of the time. It may match a different mix than the one on your record.
- Tracks with no match are retried after 30 days.

## Setup

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Optional, only if the Discogs collection is private: create a token at Discogs **Settings → Developers → Generate new token** and add it as the repository secret `DISCOGS_TOKEN` (**Settings → Secrets and variables → Actions**). A token also doubles the API rate limit.
3. Optional, to sync your edits and mixes across devices: create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) limited to this repository with **Contents: read and write**, then paste it in the app under Settings. Without it, edits and mixes stay in the browser you made them in (use Download backup to move them).

For the Value tab, a `DISCOGS_TOKEN` is strongly recommended: without one Crate only sees the cheapest copy for sale. With one it also gets Discogs' own collection value (minimum / median / maximum) and price suggestions per condition. Discogs only gives price suggestions once the account's [seller settings](https://www.discogs.com/settings/seller) are filled in (nothing has to be listed). Prices come in your Discogs currency; without a token they're in EUR unless you set the repository variable `DISCOGS_CURRENCY`.

To use a different Discogs account, set the repository variable `DISCOGS_USERNAME`.

## Running locally

```sh
pip install -r sync/requirements.txt
python sync/sync_discogs.py && python sync/value.py && python sync/enrich.py && python sync/build.py
python -m http.server -d site 8000
```

## Testing the match score

```sh
node --test eval/*.test.js         # behaviour checks for site/match.js (no data needed)
python sync/build.py               # builds site/data.json
node eval/evaluate.js              # ratings from user/state.json (synced from the app)
node eval/evaluate.js backup.json  # or from a Settings › Download backup file; --weights prints the learned weights
```

`eval/evaluate.js` compares the old weighted average (`eval/legacy.js`), the model's default weights and the weights learned from your ratings (5-fold cross-validated) on the same rated pairs: how often "80%+" actually worked, a calibration table, AUC, Brier score and log loss. The **Test match score** workflow runs the checks on every change and the evaluation weekly, into the run summary. To improve the model: rate more pairs, change `site/match.js`, and keep the change only if the evaluation gets better.

