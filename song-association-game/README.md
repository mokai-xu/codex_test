# Song Association Game

A minimalist single- or multi-player challenge built with React + Vite. Configure a timer, invite friends in the lobby, and race to submit a song + artist whose lyrics include the prompted word. Each validated submission scores a point and advances the game through 10 curated words before surfacing a leaderboard recap.

## Features
- Lobby with player roster management and configurable round timer (default 20s)
- 10-round gameplay loop with curated, substantive word prompts
- Real-time scoreboard plus per-player submission status cards
- Automatic lyric checks via [lyrics.ovh](https://lyrics.ovh) before awarding points
- Countdown timer per word that advances on a successful match or when the timer expires
- Post-game leaderboard with round-by-round recap, replay, and lobby shortcuts

## Getting Started
```bash
cd song-association-game
npm install
npm run dev
```
The dev server prints a local URL (default `http://localhost:5173`). Open it in a modern browser.

## Gameplay Flow
1. **Lobby** – Add at least one player, adjust the timer (10–60 seconds), and start the 10-word session.
2. **Round** – Everyone sees the same word and submits a song + artist. The first validated submission earns the point; otherwise the timer expiration moves to the next word.
3. **Leaderboard** – Review standings and per-round outcomes, then replay instantly or return to the lobby to adjust players/timer.

## Lyrics Validation
Song checks call the public `lyrics.ovh` endpoint. Responses can be slow or rate-limited, so failed validations surface actionable error states (lyrics not found, network issues, or missing word). For production, consider swapping in a more reliable lyrics provider with authentication, caching, and debouncing per player.
