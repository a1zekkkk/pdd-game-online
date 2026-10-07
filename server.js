const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const questions = require('./questions.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
    console.log('Подключился игрок:', socket.id);

    // --- СОЗДАНИЕ КОМНАТЫ ---
    socket.on('createRoom', ({ playerName, avatarId }) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        const name = (playerName || 'Игрок').slice(0, 20);
        const avatar = avatarId || 1;
        const ticketData = pickRandomTicket(questions);

        rooms[roomCode] = {
            players: [socket.id],
            names: { [socket.id]: name },
            avatars: { [socket.id]: avatar },
            currentQuestionIndex: 0,
            scores: { [socket.id]: 0 },
            gameQuestions: ticketData.questions,
            currentTicket: ticketData.ticketNumber,
            answers: {},
            rematchVotes: {},
            rematchTimer: null
        };

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('Создана комната:', roomCode, 'Игрок:', name, 'Билет:', ticketData.ticketNumber);
    });

    // --- ПОДКЛЮЧЕНИЕ К КОМНАТЕ ---
    socket.on('joinRoom', ({ roomCode, playerName, avatarId }) => {
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('errorMessage', 'Комната не найдена');
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('errorMessage', 'Комната заполнена');
            return;
        }

        const name = (playerName || 'Игрок').slice(0, 20);
        const avatar = avatarId || 1;

        room.players.push(socket.id);
        room.names[socket.id] = name;
        room.avatars[socket.id] = avatar;
        room.scores[socket.id] = 0;
        socket.join(roomCode);

        console.log('Игрок вошёл:', roomCode, 'Имя:', name, 'Билет:', room.currentTicket);

        io.to(roomCode).emit('playersInfo', {
            names: room.names,
            avatars: room.avatars,
            players: room.players
        });

        // Показываем анимацию выбора билета
        io.to(roomCode).emit('ticketChosen', { ticketNumber: room.currentTicket });

        // Через 3 секунды — старт первого вопроса
        setTimeout(() => {
            startNewRound(roomCode);
        }, 3200);
    });

    // --- ОТВЕТ НА ВОПРОС ---
    socket.on('submitAnswer', ({ roomCode, answerIndex, timeLeft }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.answers[socket.id] !== undefined) return;

        const currentQuestion = room.gameQuestions[room.currentQuestionIndex];
        const isCorrect = answerIndex === currentQuestion.correct;

        room.answers[socket.id] = { answerIndex, isCorrect, timeLeft };

        if (isCorrect) {
            const points = 10 + Math.max(0, timeLeft);
            room.scores[socket.id] += points;
        }

        socket.emit('yourAnswer', {
            isCorrect,
            correctIndex: currentQuestion.correct
        });

        socket.to(roomCode).emit('opponentAnswered', { isCorrect });

        if (Object.keys(room.answers).length === room.players.length) {
            endRound(roomCode);
        }
    });

    // --- ЗАПРОС РЕВАНША ---
    socket.on('requestRematch', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.rematchVotes[socket.id] = true;

        socket.to(roomCode).emit('rematchWaiting');

        if (Object.keys(room.rematchVotes).length === room.players.length) {
            if (room.rematchTimer) {
                clearTimeout(room.rematchTimer);
                room.rematchTimer = null;
            }
            startRematch(roomCode);
        } else {
            if (!room.rematchTimer) {
                room.rematchTimer = setTimeout(() => {
                    const r = rooms[roomCode];
                    if (!r) return;
                    io.to(roomCode).emit('rematchCanceled', 'Соперник не ответил. Возвращаемся в меню.');
                    cleanupRoom(roomCode);
                }, 30000);
            }
        }
    });

    // --- ОТМЕНА РЕВАНША ---
    socket.on('cancelRematch', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.rematchTimer) {
            clearTimeout(room.rematchTimer);
            room.rematchTimer = null;
        }

        socket.to(roomCode).emit('rematchCanceled', 'Соперник отказался от реванша.');
        cleanupRoom(roomCode);
    });

    socket.on('disconnect', () => {
        console.log('Игрок отключился:', socket.id);
    });
});

// --- ХЕЛПЕРЫ ---

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.answers = {};

    io.to(roomCode).emit('nextQuestion', {
        question: room.gameQuestions[room.currentQuestionIndex],
        questionNumber: room.currentQuestionIndex + 1,
        totalQuestions: room.gameQuestions.length
    });
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const currentQuestion = room.gameQuestions[room.currentQuestionIndex];

    io.to(roomCode).emit('roundResult', {
        correctIndex: currentQuestion.correct,
        scores: room.scores,
        names: room.names,
        avatars: room.avatars,
        answers: room.answers
    });

    setTimeout(() => {
        room.currentQuestionIndex++;

        if (room.currentQuestionIndex < room.gameQuestions.length) {
            startNewRound(roomCode);
        } else {
            const [id1, id2] = room.players;
            const score1 = room.scores[id1];
            const score2 = room.scores[id2];
            const name1 = room.names[id1];
            const name2 = room.names[id2];
            const avatar1 = room.avatars[id1];
            const avatar2 = room.avatars[id2];

            if (score1 > score2) {
                io.to(id1).emit('youWon', { myScore: score1, opponentScore: score2, myName: name1, opponentName: name2, myAvatar: avatar1, opponentAvatar: avatar2 });
                io.to(id2).emit('youLost', { myScore: score2, opponentScore: score1, myName: name2, opponentName: name1, myAvatar: avatar2, opponentAvatar: avatar1 });
            } else if (score2 > score1) {
                io.to(id2).emit('youWon', { myScore: score2, opponentScore: score1, myName: name2, opponentName: name1, myAvatar: avatar2, opponentAvatar: avatar1 });
                io.to(id1).emit('youLost', { myScore: score1, opponentScore: score2, myName: name1, opponentName: name2, myAvatar: avatar1, opponentAvatar: avatar2 });
            } else {
                io.to(id1).emit('youTied', { myScore: score1, opponentScore: score2, myName: name1, opponentName: name2, myAvatar: avatar1, opponentAvatar: avatar2 });
                io.to(id2).emit('youTied', { myScore: score2, opponentScore: score1, myName: name2, opponentName: name1, myAvatar: avatar2, opponentAvatar: avatar1 });
            }
        }
    }, 2500);
}

function startRematch(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentQuestionIndex = 0;
    room.answers = {};
    room.rematchVotes = {};
    room.rematchTimer = null;

    room.players.forEach(id => { room.scores[id] = 0; });

    const ticketData = pickRandomTicket(questions);
    room.gameQuestions = ticketData.questions;
    room.currentTicket = ticketData.ticketNumber;

    // Показываем анимацию выбора билета
    io.to(roomCode).emit('rematchStarting');

    setTimeout(() => {
        io.to(roomCode).emit('ticketChosen', { ticketNumber: room.currentTicket });
        setTimeout(() => {
            startNewRound(roomCode);
        }, 3200);
    }, 500);
}

function cleanupRoom(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.rematchTimer) {
        clearTimeout(room.rematchTimer);
    }
    delete rooms[roomCode];
}

// Возвращает { questions: [...], ticketNumber: N }
function pickRandomTicket(allQuestions) {
    const ticketNumbers = [...new Set(allQuestions.map(q => q.ticket))];
    const randomTicket = ticketNumbers[Math.floor(Math.random() * ticketNumbers.length)];
    const ticketQuestions = allQuestions.filter(q => q.ticket === randomTicket);
    const shuffled = [...ticketQuestions].sort(() => 0.5 - Math.random());
    return {
        questions: shuffled.slice(0, Math.min(10, shuffled.length)),
        ticketNumber: randomTicket
    };
}

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('✅ Сервер запущен! Открой в браузере: http://localhost:3000');
});