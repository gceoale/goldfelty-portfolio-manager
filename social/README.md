# goldfelty-social

Runs Goldfelty's own X, Reddit and YouTube accounts on autopilot: it writes
posts, has Claude check each one against the facts you give it, publishes the
ones that pass at a steady pace, reads how they did, and writes better ones
next time. It runs in the background from login. You can also switch
autopilot off and approve every post yourself.

It is the Node.js successor to the Swift "viral-engine" app, with these
changes:

| viral-engine | goldfelty-social |
|---|---|
| "The Algorithm" persona | Posts openly as Goldfelty, grounded in a facts file you control |
| Posted everything it generated, unchecked | A second Claude pass fact-checks every draft before it posts (or you approve by hand) |
| Up to 5 X slots a day, every thread each time | At most 3 X posts a day, at most 1 of them a thread |
| Reddit posts to any subreddit | Posts only to your profile and subreddits you moderate; anything else becomes a draft for you to post by hand |
| Expired tokens were never refreshed | Tokens refresh before expiry and on a 401, on all three platforms |
| AI voice over slides, macOS only | Funny Shorts written by Claude, judged for laughs, voiced, animated with the real app and captioned, on any OS |
| macOS only, Swift | Node.js 20+, any OS |
| claude-sonnet-4-6, raw HTTP | claude-opus-5-5 through the official SDK, with structured output |

## How Goldfelty runs it

Nobody's computer needs to be on. The scheduled workflow
`.github/workflows/social.yml` runs `goldfelty-social cloud-run` every half
hour on GitHub. Each run downloads its settings, sign-ins and queue from
api.goldfelty.com, writes and checks posts when the stock runs low, makes the
day's Short inside the YouTube window, posts whatever is due, reads how posts
did, and uploads everything again. The queue is uploaded after every post, and
the dashboard is asked once more right before each one, so pausing or pulling
an item takes effect even mid-run.

Everything is managed at **goldfelty.com/admin/social/** (with the admin
token):

- Connect X, Reddit and YouTube. Each needs a free developer app; the page
  shows the callback URL to register and where to create it.
- Keys: Anthropic (needed), OpenAI or ElevenLabs (voices for Shorts), time
  zone, posting windows, Short visibility.
- What it may say about Goldfelty (the facts file).
- Pause/resume, what's coming up (with Remove), what was posted (with likes,
  reposts, replies and views), what was turned down and why, run history.

Settings and sign-ins are stored encrypted (AES-256-GCM, key derived from
the API's ADMIN_TOKEN) in the API's D1 database; see `api/src/social.js`.
The workflow needs only the `GOLDFELTY_ADMIN_TOKEN` repository secret, which
the dashboard already uses. Secrets it loads are masked in the (public)
Actions logs.

Running it on a computer instead, as below, still works.

## Install

```sh
npm install
npm link            # optional: puts `goldfelty-social` on your PATH
goldfelty-social init
```

`init` creates `~/.goldfelty-social/` (readable only by you) with:

- `config.json`: API keys, posting windows, caps.
- `facts.md`: everything posts may say about Goldfelty. **Edit this when
  something changes.** Claude may only use what is in it.
- Later: `tokens.json` (sign-ins), `queue.json` (drafts and posts),
  `activity.log`.

## Keys

Put these in `~/.goldfelty-social/config.json`.

**Claude**: set `ANTHROPIC_API_KEY` in your environment, or
`anthropicApiKey` in the config.

**X**: at developer.x.com, create a project and an app. Under *User
authentication settings*, turn on OAuth 2.0, type *Native App* (or *Web App*
if you want a client secret), and add the callback
`http://127.0.0.1:8787/callback`. Copy the OAuth 2.0 Client ID (and secret,
if any) into `x.clientId` / `x.clientSecret`. Check what your X API plan
allows: `stats` needs one that can read posts, and on plans with tight read
limits it may fail; posting is unaffected.

**Reddit**: at reddit.com/prefs/apps, *create another app*, type *installed
app*, redirect URI `http://127.0.0.1:8787/callback`. Copy the id under the app
name into `reddit.clientId` (leave `clientSecret` empty).

**YouTube**: in Google Cloud Console, enable *YouTube Data API v3*, set up the
OAuth consent screen (add yourself as a test user), and create an OAuth client
of type *Desktop app*. Copy the client ID and secret into `youtube.clientId` /
`youtube.clientSecret`. Until Google audits your project, videos uploaded
through the API are locked to private; you can publish them in YouTube Studio.

Then sign in to each:

```sh
goldfelty-social connect x
goldfelty-social connect reddit
goldfelty-social connect youtube
```

## Autopilot

After `init`, adding keys and connecting accounts:

```sh
goldfelty-social run --live --auto     # try it in a terminal first
goldfelty-social service install       # then leave it running for good
```

`service install` runs it in the background (launchd on macOS, systemd on
Linux, Task Scheduler on Windows), starts it at login and restarts it if it
stops. Your computer needs to be on and online for it to post.

What it does by itself:

- Keeps two days of posts ready. When the stock runs low it writes a batch,
  at most once every 12 hours.
- Sends every draft through a second Claude check at high effort: every claim
  must match `facts.md`, no advice or hype, nothing dull or repeated. It picks
  the strongest opening, then approves or rejects. The rule checks (length,
  no tags, caps, your own subreddits only) still apply on top.
- Posts approved items in your posting windows, within the daily caps.
- Reads likes, reposts, replies and views every 6 hours and feeds the best
  and weakest into the next batch.
- YouTube: makes one funny Short a day and uploads it in the next YouTube
  window (see "Shorts" below). You can also drop your own video into
  `~/.goldfelty-social/videos/` (optionally with a `.txt` of the same name
  describing it); it writes the title and description and uploads that too.
- Renews sign-ins by itself. If one is revoked, posts for that account wait
  and the log says to run `connect` again.

Keeping an eye on it:

```sh
goldfelty-social pause        # stops all writing and posting at once
goldfelty-social resume
goldfelty-social status
goldfelty-social ui           # see what's queued, posted and rejected, and why; pause from there too
goldfelty-social service uninstall
```

Everything it does is in `~/.goldfelty-social/activity.log`. Keep `facts.md`
current: it's the only thing autopilot may claim about Goldfelty. On X, mark
the account as automated (Settings > Your account > Account information >
Automation); X asks for that on accounts run by software.

## Shorts

Every day autopilot makes a 30 to 45 second vertical video starring the real
app:

1. Claude writes a comedy script about everyday self-custody pain (seven
   wallets and no idea what's in which, 40 tabs to add up one number, the
   spreadsheet from March) with Goldfelty as the payoff. Formats rotate: text
   message chats, two-character skits, POV, nature documentary, movie trailer.
2. A second pass, as a tough comedy editor, scores it for laughs and for the
   hook, and checks every claim against `facts.md`. Below 7/10 or inaccurate,
   it's rewritten with the editor's notes (up to three tries).
3. Each character gets a voice and a delivery style (anxious, smug, deadpan,
   dramatic, narrator).
4. It's animated: talking characters with googly eyes, phone chats, a pile-up
   of tabs, real Goldfelty screens zooming into the part that matters (marked
   "demo wallets"), word-by-word captions, sound effects, an outro with
   goldfelty.com. 1080×1920, 30 fps, loudness set for YouTube.
5. It's queued and uploaded as a Short. Views, likes and comments feed into
   the next script.

Try it without spending anything on Claude:

```sh
goldfelty-social video --sample
```

and make a real one:

```sh
goldfelty-social video                 # Claude writes it; add --format "nature documentary" to steer
goldfelty-social video --queue         # and add it to the YouTube queue
```

Videos land in `~/.goldfelty-social/videos/made/` with the script next to
each one.

**Voices.** The voice decides whether the jokes land. Add one key to
`config.json`:

- `video.openaiApiKey` (OpenAI `gpt-4o-mini-tts`, which acts out the delivery
  style; about a cent per video), or
- `video.elevenlabsApiKey` (most natural; pick voices with
  `video.elevenlabsVoices`, e.g. `{"deadpan": "<voice id>"}`).

Without a key it uses the computer's own voice (`say` on macOS, Windows
speech, `espeak-ng` on Linux), which works but isn't funny. `"tts": "none"`
makes caption-only videos.

**Music.** Put tracks you're allowed to use (YouTube Audio Library is free) in
`~/.goldfelty-social/music/`; one is mixed in quietly under each video.

**Your own screens.** Save a screenshot as
`~/.goldfelty-social/screens/overview.png` (or any name in
`src/video/screens.js`) to replace the bundled one.

**Needs.** `npm install` brings Playwright (draws the frames) and ffmpeg. If
Playwright's browser isn't installed, run `npx playwright install chromium`;
it can also use your installed Chrome or Edge. A video takes about two minutes
to render. Turn daily videos off with `"video": {"auto": false}`.

## Use it by hand

```sh
goldfelty-social generate                   # write a batch of drafts
goldfelty-social ui                         # review, edit, approve in your browser
goldfelty-social run                        # dry run: shows what would go out, posts nothing
goldfelty-social run --live                 # post what you approved, on schedule
```

`run` also opens the review page, so leave it running and check in when it
suits you. Everything else:

```
status, list [--status S], show ID, approve ID..., reject ID...,
done ID [--url URL], post ID --live, attach ID IMAGE..., stats,
upload FILE --title T [--description D] [--privacy public|unlisted|private],
disconnect x|reddit|youtube
```

## Getting posts to travel

Things that help reach without looking like spam, and what this app does for
each:

- **First line does the work.** Drafts lead with the concrete point (a step, a
  limitation, a decision and its reason). Each X post comes with two other
  openings; pick the strongest with *Use this*.
- **A mix of formats.** Each batch mixes how-tos, myth versus fact,
  behind-the-build notes, checklists people save, release notes and honest
  limitations, instead of announcements.
- **Images.** Posts with a screenshot get far more attention than bare text.
  `goldfelty-social attach ID screenshot.png` puts up to 4 on a post (or the
  first post of a thread).
- **Learning from your own numbers.** While `run --live` is going, it reads
  likes, reposts, replies and views every 6 hours. The next batch is told
  which posts did best and worst and why that might be. `stats` and the
  *Posted* tab show which posting windows do best; move your `windows` in
  config.json toward them.
- **Reply to people who reply to you.** This app never replies or tags anyone.
  Answering comments on your own posts yourself is one of the strongest signals
  on every platform; check *Posted* for posts with replies.
- **Video.** Short screen recordings of a real task (connect a wallet, check a
  download) do well on YouTube and can be cut down for X. Scripts land under
  *Yours to do*; record them and `upload` the file.

What it won't do, because platforms penalise or ban it and it costs trust:
post more than the caps, post the same thing twice, tag accounts, use more
than two hashtags, reply to strangers, post in communities you don't run, or
claim anything that isn't in `facts.md`.

## Posting rules

- Each platform has posting windows (local time). Each window gets one random
  minute per day, and at most one post goes out per window.
- Daily caps: X 3 (at most 1 thread), Reddit 1, YouTube 1. `config.json` can
  lower these but not raise them. There is also a minimum gap between posts.
- A post that fails for a temporary reason (rate limit, server error) is tried
  again 30 minutes later, up to 3 times. A thread that fails partway carries
  on from where it stopped instead of reposting the start.
- If the app is stopped mid-post, that item is marked *failed* rather than
  retried, because it may already be live. Check the account, then approve it
  again if it isn't.
- If an account's sign-in has expired for good, items wait and the error says
  to run `connect` again.

## Claude

Drafts come from `claude-opus-5-5` through the official
`@anthropic-ai/sdk`, with a JSON schema for the reply. Refusal fallbacks are
on (`fallbacks: "default"`): if a safety check wrongly declines a batch, the
API retries it on the model Anthropic recommends instead of failing. Drafts
that break the rules (too long, tag someone, repeat a recent post) are dropped
before you see them, and the command says why.

## Tests

```sh
npm test
```

They cover the queue, scheduling and caps, token refresh on all three
platforms, posting (threads, partial failures, Reddit target checks, YouTube
upload, X images), reading numbers, the Claude requests, autopilot, the video
script loop, voices, the audio mix, every scene of the video player, a real
end-to-end render, and the review page's access checks. All network calls are mocked; nothing here has been run against
the live X, Reddit or YouTube APIs yet.
