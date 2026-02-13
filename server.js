const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files with proper MIME types
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Game state
const gameState = {
  players: {},
  gameMaster: null,
  currentRound: 0,
  maxRounds: 10,
  phase: 'waiting', // waiting, prompt, submitting, voting, results, commenting, ended
  currentPrompt: '',
  gifs: {}, // playerId -> { url, previewUrl }
  votes: {},
  comments: {}, // oderId -> { gifId, comment }
  timer: null,
  timerEndTime: null,
  gameHistory: [] // Array of round data for HTML export
};

// Helper functions
function getPlayersList() {
  return Object.values(gameState.players).map(p => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    points: p.points,
    isGM: p.isGM
  }));
}

function broadcastGameState() {
  io.emit('game:state', {
    phase: gameState.phase,
    currentRound: gameState.currentRound,
    maxRounds: gameState.maxRounds,
    currentPrompt: gameState.currentPrompt,
    players: getPlayersList(),
    gameMaster: gameState.gameMaster
  });
}

function startSubmittingPhase() {
  gameState.phase = 'submitting';
  gameState.gifs = {};
  gameState.votes = {};
  gameState.timerEndTime = Date.now() + 60000; // 60 seconds to find a GIF
  
  io.emit('phase:submitting', {
    prompt: gameState.currentPrompt,
    timerEndTime: gameState.timerEndTime
  });
  
  // Auto-advance after 60 seconds
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.timer = setTimeout(() => {
    startVotingPhase();
  }, 60000);
}

function startVotingPhase() {
  if (gameState.timer) clearTimeout(gameState.timer);
  
  // Check if any GIFs were submitted
  const gifsList = Object.entries(gameState.gifs).map(([playerId, gifData]) => ({
    id: playerId,
    url: gifData.url,
    previewUrl: gifData.previewUrl
  }));
  
  // If no GIFs submitted, skip voting and go straight to results
  if (gifsList.length === 0) {
    endRound();
    return;
  }
  
  gameState.phase = 'voting';
  
  // Shuffle gifs
  for (let i = gifsList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [gifsList[i], gifsList[j]] = [gifsList[j], gifsList[i]];
  }
  
  gameState.timerEndTime = Date.now() + 60000; // 1 minute to vote
  
  io.emit('phase:voting', {
    gifs: gifsList,
    timerEndTime: gameState.timerEndTime
  });
  
  // Auto-advance after 1 minute
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.timer = setTimeout(() => {
    endRound();
  }, 60000);
}

function endRound() {
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.phase = 'results';
  
  // Calculate points
  const results = {};
  Object.entries(gameState.votes).forEach(([gifId, voters]) => {
    const points = voters.length;
    if (gameState.players[gifId]) {
      gameState.players[gifId].points += points;
      results[gifId] = {
        playerId: gifId,
        playerName: gameState.players[gifId].name,
        playerEmoji: gameState.players[gifId].emoji,
        gifUrl: gameState.gifs[gifId]?.url,
        previewUrl: gameState.gifs[gifId]?.previewUrl,
        votes: points
      };
    }
  });
  
  // Include players who submitted but got 0 votes
  Object.keys(gameState.gifs).forEach(playerId => {
    if (!results[playerId] && gameState.players[playerId]) {
      results[playerId] = {
        playerId: playerId,
        playerName: gameState.players[playerId].name,
        playerEmoji: gameState.players[playerId].emoji,
        gifUrl: gameState.gifs[playerId]?.url,
        previewUrl: gameState.gifs[playerId]?.previewUrl,
        votes: 0
      };
    }
  });
  
  const isLastRound = gameState.currentRound >= gameState.maxRounds;
  
  // On last round, set a 45 second timer for auto-end
  let timerEndTime = null;
  if (isLastRound) {
    timerEndTime = Date.now() + 45000;
    if (gameState.timer) clearTimeout(gameState.timer);
    gameState.timer = setTimeout(() => {
      if (gameState.phase === 'results') {
        endGame();
      }
    }, 45000);
  }
  
  io.emit('phase:results', {
    results: Object.values(results),
    leaderboard: getPlayersList().sort((a, b) => b.points - a.points),
    isLastRound: isLastRound,
    timerEndTime: timerEndTime,
    hasGifs: Object.keys(gameState.gifs).length > 0
  });
}

function startCommentingPhase() {
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.phase = 'commenting';
  gameState.comments = {}; // { oderId: { voteComment, ownComment, votedGifId, ownGifId } }
  gameState.timerEndTime = Date.now() + 90000; // 90 seconds to comment
  
  // Prepare GIFs for commenting (with player info)
  const gifsList = Object.entries(gameState.gifs).map(([playerId, gifData]) => ({
    id: playerId,
    playerName: gameState.players[playerId]?.name || 'Unknown',
    playerEmoji: gameState.players[playerId]?.emoji || '😀',
    url: gifData.url,
    previewUrl: gifData.previewUrl
  }));
  
  // Build map of who voted for what
  const playerVotes = {};
  Object.entries(gameState.votes).forEach(([gifId, voters]) => {
    voters.forEach(voterId => {
      playerVotes[voterId] = gifId;
    });
  });
  
  io.emit('phase:commenting', {
    gifs: gifsList,
    playerVotes: playerVotes,
    timerEndTime: gameState.timerEndTime
  });
  
  // Auto-advance after 90 seconds
  gameState.timer = setTimeout(() => {
    saveRoundAndAdvance();
  }, 90000);
}

function saveRoundAndAdvance() {
  if (gameState.timer) clearTimeout(gameState.timer);
  
  // Build round history entry
  const roundData = {
    round: gameState.currentRound,
    prompt: gameState.currentPrompt,
    gifs: []
  };
  
  // Add each GIF with its votes and comments
  Object.entries(gameState.gifs).forEach(([playerId, gifData]) => {
    const gifEntry = {
      playerId: playerId,
      playerName: gameState.players[playerId]?.name || 'Unknown',
      playerEmoji: gameState.players[playerId]?.emoji || '😀',
      url: gifData.url,
      previewUrl: gifData.previewUrl,
      votes: gameState.votes[playerId]?.length || 0,
      comments: []
    };
    
  // Add comments for this GIF (both vote comments and own GIF comments)
    Object.entries(gameState.comments).forEach(([oderId, commentData]) => {
      // Comment from someone who voted for this GIF
      if (commentData.votedGifId === playerId && commentData.voteComment) {
        gifEntry.comments.push({
          oderId: oderId,
          voterName: gameState.players[oderId]?.name || 'Anonymous',
          comment: commentData.voteComment,
          type: 'vote'
        });
      }
      // Comment from the owner about their own GIF
      if (commentData.ownGifId === playerId && commentData.ownComment) {
        gifEntry.comments.push({
          oderId: oderId,
          voterName: gameState.players[oderId]?.name || 'Anonymous',
          comment: commentData.ownComment,
          type: 'own'
        });
      }
    });
    
    roundData.gifs.push(gifEntry);
  });
  
  // Sort by votes
  roundData.gifs.sort((a, b) => b.votes - a.votes);
  gameState.gameHistory.push(roundData);
  
  // Check if game is over
  if (gameState.currentRound >= gameState.maxRounds) {
    endGame();
  } else {
    // Auto-advance to next round
    gameState.currentRound++;
    gameState.phase = 'prompt';
    broadcastGameState();
  }
}

function endGame() {
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.phase = 'ended';
  const leaderboard = getPlayersList().sort((a, b) => b.points - a.points);
  
  const topScore = leaderboard.length > 0 ? leaderboard[0].points : 0;
  const topWinners = leaderboard.filter(p => p.points === topScore && topScore > 0);
  const winner = topWinners.length > 1 ? topWinners : (topWinners.length === 1 ? topWinners[0] : null);
  
  io.emit('game:ended', {
    leaderboard: leaderboard,
    winner: winner,
    history: gameState.gameHistory
  });
  
  // Reset game after a delay to let clients download HTML, then kick everyone
  setTimeout(() => {
    resetGame();
    io.emit('game:reset', { message: 'Game over! Returning to lobby...' });
  }, 8000);
}

function resetGame() {
  if (gameState.timer) clearTimeout(gameState.timer);
  gameState.players = {};
  gameState.gameMaster = null;
  gameState.currentRound = 0;
  gameState.maxRounds = 10;
  gameState.phase = 'waiting';
  gameState.currentPrompt = '';
  gameState.gifs = {};
  gameState.votes = {};
  gameState.comments = {};
  gameState.timer = null;
  gameState.timerEndTime = null;
  gameState.gameHistory = [];
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Check if GM exists
  socket.on('gm:check', () => {
    socket.emit('gm:status', { hasGM: gameState.gameMaster !== null });
  });
  
  // Player joins
  socket.on('player:join', (data) => {
    gameState.players[socket.id] = {
      id: socket.id,
      name: data.name,
      emoji: data.emoji,
      points: 0,
      isGM: data.isGM || false
    };
    
    // Only allow GM if none exists
    if (data.isGM && gameState.gameMaster === null) {
      gameState.gameMaster = socket.id;
      gameState.players[socket.id].isGM = true;
    } else if (data.isGM && gameState.gameMaster !== null) {
      gameState.players[socket.id].isGM = false;
    }
    
    socket.emit('player:joined', {
      playerId: socket.id,
      isGM: gameState.players[socket.id].isGM
    });
    
    io.emit('gm:status', { hasGM: gameState.gameMaster !== null });
    io.emit('players:update', getPlayersList());
    broadcastGameState();
    
    // Sync new player to current phase
    if (gameState.phase === 'submitting') {
      socket.emit('phase:submitting', {
        prompt: gameState.currentPrompt,
        timerEndTime: gameState.timerEndTime
      });
    } else if (gameState.phase === 'voting') {
      const gifsList = Object.entries(gameState.gifs).map(([playerId, gifData]) => ({
        id: playerId,
        url: gifData.url,
        previewUrl: gifData.previewUrl
      }));
      for (let i = gifsList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gifsList[i], gifsList[j]] = [gifsList[j], gifsList[i]];
      }
      socket.emit('phase:voting', { gifs: gifsList, timerEndTime: gameState.timerEndTime });
      
      const voteCounts = {};
      Object.entries(gameState.votes).forEach(([gifId, voters]) => {
        voteCounts[gifId] = voters.length;
      });
      socket.emit('votes:update', voteCounts);
    } else if (gameState.phase === 'results') {
      const results = {};
      Object.entries(gameState.votes).forEach(([gifId, voters]) => {
        const points = voters.length;
        if (gameState.players[gifId]) {
          results[gifId] = {
            playerId: gifId,
            playerName: gameState.players[gifId].name,
            playerEmoji: gameState.players[gifId].emoji,
            gifUrl: gameState.gifs[gifId]?.url,
            previewUrl: gameState.gifs[gifId]?.previewUrl,
            votes: points
          };
        }
      });
      socket.emit('phase:results', {
        results: Object.values(results),
        leaderboard: getPlayersList().sort((a, b) => b.points - a.points)
      });
    }
  });
  
  // GM starts game
  socket.on('game:start', (data) => {
    if (socket.id === gameState.gameMaster && gameState.phase === 'waiting') {
      const nonGMPlayers = Object.keys(gameState.players).filter(id => id !== gameState.gameMaster);
      if (nonGMPlayers.length < 2) {
        socket.emit('game:error', { message: 'Need at least 2 players (not including Game Master) to start!' });
        return;
      }
      
      // Set max rounds from GM selection
      if (data && data.maxRounds) {
        gameState.maxRounds = Math.min(50, Math.max(1, parseInt(data.maxRounds) || 10));
      }
      
      gameState.currentRound = 1;
      gameState.phase = 'prompt';
      broadcastGameState();
    }
  });
  
  // GM submits prompt
  socket.on('prompt:submit', (data) => {
    if (socket.id === gameState.gameMaster && gameState.phase === 'prompt') {
      gameState.currentPrompt = data.prompt;
      startSubmittingPhase();
    }
  });
  
  // Player submits GIF
  socket.on('gif:submit', (data) => {
    if (gameState.phase === 'submitting' && socket.id !== gameState.gameMaster) {
      gameState.gifs[socket.id] = {
        url: data.url,
        previewUrl: data.previewUrl || data.url
      };
      
      const nonGMPlayers = Object.keys(gameState.players).filter(id => id !== gameState.gameMaster);
      const submittedCount = Object.keys(gameState.gifs).length;
      
      io.emit('gifs:submitted', {
        count: submittedCount,
        total: nonGMPlayers.length
      });
      
      if (submittedCount === nonGMPlayers.length) {
        startVotingPhase();
      }
    }
  });
  
  // Player votes
  socket.on('vote:cast', (data) => {
    if (gameState.phase === 'voting' && data.gifId !== socket.id && socket.id !== gameState.gameMaster) {
      // Remove previous vote
      Object.keys(gameState.votes).forEach(gifId => {
        if (gameState.votes[gifId]) {
          gameState.votes[gifId] = gameState.votes[gifId].filter(voterId => voterId !== socket.id);
        }
      });
      
      if (!gameState.votes[data.gifId]) {
        gameState.votes[data.gifId] = [];
      }
      gameState.votes[data.gifId].push(socket.id);
      
      const voteCounts = {};
      Object.entries(gameState.votes).forEach(([gifId, voters]) => {
        voteCounts[gifId] = voters.length;
      });
      
      io.emit('votes:update', voteCounts);
      
      const nonGMPlayers = Object.keys(gameState.players).filter(id => id !== gameState.gameMaster);
      const totalVotes = Object.values(gameState.votes).flat().length;
      
      if (totalVotes === nonGMPlayers.length) {
        endRound();
      }
    }
  });
  
  // GM starts commenting phase
  socket.on('start:commenting', () => {
    if (socket.id === gameState.gameMaster && gameState.phase === 'results') {
      startCommentingPhase();
    }
  });
  
  // GM skips commenting and goes to next round
  socket.on('round:next', () => {
    if (socket.id === gameState.gameMaster && gameState.phase === 'results') {
      // Save round without comments and advance
      const roundData = {
        round: gameState.currentRound,
        prompt: gameState.currentPrompt,
        gifs: Object.entries(gameState.gifs).map(([playerId, gifData]) => ({
          playerId,
          playerName: gameState.players[playerId]?.name || 'Unknown',
          playerEmoji: gameState.players[playerId]?.emoji || '😀',
          url: gifData.url,
          previewUrl: gifData.previewUrl,
          votes: gameState.votes[playerId]?.length || 0,
          comments: []
        })).sort((a, b) => b.votes - a.votes)
      };
      gameState.gameHistory.push(roundData);
      
      if (gameState.currentRound >= gameState.maxRounds) {
        endGame();
      } else {
        gameState.currentRound++;
        gameState.phase = 'prompt';
        broadcastGameState();
      }
    }
  });
  
  // Player submits comments (both vote comment and own GIF comment)
  socket.on('comment:submit', (data) => {
    if (gameState.phase === 'commenting' && socket.id !== gameState.gameMaster) {
      gameState.comments[socket.id] = {
        votedGifId: data.votedGifId,
        voteComment: data.voteComment,
        ownGifId: data.ownGifId,
        ownComment: data.ownComment
      };
      
      const nonGMPlayers = Object.keys(gameState.players).filter(id => id !== gameState.gameMaster);
      const submittedCount = Object.keys(gameState.comments).length;
      
      io.emit('comments:submitted', {
        count: submittedCount,
        total: nonGMPlayers.length
      });
      
      // If all players submitted, auto-advance
      if (submittedCount === nonGMPlayers.length) {
        saveRoundAndAdvance();
      }
    }
  });
  
  // Player disconnects - only GM leaving ends the game, regular players just leave
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    
    if (gameState.players[socket.id]) {
      const wasGM = gameState.players[socket.id].isGM;
      
      if (wasGM) {
        // GM left - end the game and reset everything
        if (gameState.phase !== 'waiting' && gameState.phase !== 'ended') {
          const leaderboard = getPlayersList().sort((a, b) => b.points - a.points);
          const topScore = leaderboard.length > 0 ? leaderboard[0].points : 0;
          const topWinners = leaderboard.filter(p => p.points === topScore && topScore > 0);
          const winner = topWinners.length > 1 ? topWinners : (topWinners.length === 1 ? topWinners[0] : null);
          
          io.emit('game:ended', {
            leaderboard: leaderboard,
            winner: winner,
            history: gameState.gameHistory,
            reason: 'Game Master left'
          });
        }
        
        // Reset the entire game state
        resetGame();
        io.emit('game:reset', { message: 'Game Master left. Returning to lobby...' });
      } else {
        // Regular player left - just remove them, game continues
        delete gameState.players[socket.id];
        // Also remove their GIF and votes if they had any
        delete gameState.gifs[socket.id];
        delete gameState.comments[socket.id];
        Object.keys(gameState.votes).forEach(gifId => {
          if (gameState.votes[gifId]) {
            gameState.votes[gifId] = gameState.votes[gifId].filter(v => v !== socket.id);
          }
        });
        io.emit('players:update', getPlayersList());
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GIF Battle server running on http://localhost:${PORT}`);
});
