# 🎬 GIF Battle

A multiplayer party game where players respond to prompts with GIFs and vote for their favorites!

## How to Play

1. **Game Master** creates a room and writes prompts/statements
2. **Players** search for GIFs that best respond to the prompt
3. Everyone votes for their favorite GIF (can't vote for your own)
4. Points are awarded based on votes received
5. After 10 rounds, the player with the most points wins!

## Features

- Real-time multiplayer using Socket.io
- GIF search powered by Tenor API
- Same lobby/exit mechanics as PopularPoser
- 10 rounds per game
- 2 minutes to find and submit a GIF
- 1 minute voting phase
- Live leaderboard and vote counts

## Getting Started

### Install dependencies

```bash
npm install
```

### Run the server

```bash
npm start
```

### Play

1. Open `http://localhost:3000` in your browser
2. One person should join as **Game Master**
3. Other players join normally
4. Game Master starts the game when at least 2 players have joined
5. Have fun!

## Game Flow

1. **Lobby**: Players join and pick names/emojis
2. **Prompt Phase**: Game Master writes a prompt (e.g., "When you realize it's Monday tomorrow...")
3. **GIF Search Phase**: Players search and select a GIF that matches the prompt
4. **Voting Phase**: Everyone votes for their favorite GIF
5. **Results**: See who won the round and the current standings
6. Repeat for 10 rounds!

## Tech Stack

- Node.js + Express
- Socket.io for real-time communication
- Tenor API for GIF search
- Vanilla JavaScript frontend

## Credits

Inspired by PopularPoser - same lobby/exit mechanics with GIF-based gameplay!
