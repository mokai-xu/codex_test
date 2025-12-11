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

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager

### Installation
```bash
cd song-association-game
npm install
```

### Running the Application

**Option 1: Run everything together (recommended)**
```bash
npm run dev:all
```
This starts both the WebSocket server and the Vite dev server concurrently.

**Option 2: Run separately**
```bash
# Terminal 1: Start WebSocket server
npm run dev:server

# Terminal 2: Start frontend dev server
npm run dev
```

The frontend dev server will be available at `http://localhost:5173` (default).
The WebSocket server runs on `ws://localhost:3002` (default).

### Cross-Device Multiplayer
The game now supports true cross-device multiplayer via WebSockets! Multiple users can join the same room from different devices and play together in real-time.

1. One player creates a room and shares the room ID
2. Other players join using the room ID
3. All players see each other and can play simultaneously

## Gameplay Flow
1. **Lobby** – Add at least one player, adjust the timer (10–60 seconds), and start the 10-word session.
2. **Round** – Everyone sees the same word and submits a song + artist. The first validated submission earns the point; otherwise the timer expiration moves to the next word.
3. **Leaderboard** – Review standings and per-round outcomes, then replay instantly or return to the lobby to adjust players/timer.

## Lyrics Validation
Song checks call the public `lyrics.ovh` endpoint. Responses can be slow or rate-limited, so failed validations surface actionable error states (lyrics not found, network issues, or missing word). For production, consider swapping in a more reliable lyrics provider with authentication, caching, and debouncing per player.

## Deployment to Render

This app is configured to deploy on [Render](https://render.com) with WebSocket support.

### Prerequisites
- A GitHub account with this repository
- A Render account (free tier available)

### Deployment Steps

1. **Push your code to GitHub** (if not already done):
   ```bash
   git add .
   git commit -m "Prepare for Render deployment"
   git push origin main
   ```

2. **Create a new Web Service on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the repository and branch

3. **Configure the service**:
   - **Name**: `song-association-game` (or your preferred name)
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Plan**: Free (or choose a paid plan)

4. **Environment Variables** (optional):
   - `NODE_ENV`: `production` (automatically set by Render)
   - `VITE_WS_URL`: Leave empty (auto-detected in production)

5. **Deploy**:
   - Click "Create Web Service"
   - Render will build and deploy your app
   - The app will be available at `https://your-app-name.onrender.com`

### How It Works

- The server combines HTTP and WebSocket on a single port (required by Render)
- In production, the server automatically serves static files from the `dist/` directory
- WebSocket connections automatically use `wss://` (secure WebSocket) in production
- The health check endpoint is available at `/health`

### Manual Deployment (Alternative)

If you prefer to use the `render.yaml` file:

1. Ensure `render.yaml` is in your repository root
2. In Render Dashboard, go to "New +" → "Blueprint"
3. Connect your repository
4. Render will automatically detect and use `render.yaml`

### Troubleshooting

- **WebSocket not connecting**: Ensure your Render service is using HTTPS (free tier includes this)
- **Static files not loading**: Make sure `npm run build` completed successfully
- **Port errors**: Render automatically sets the `PORT` environment variable - don't override it

### Local Production Testing

To test the production build locally:

```bash
npm run build
npm start
```

The app will be available at `http://localhost:3001` with WebSocket at `ws://localhost:3001`.
