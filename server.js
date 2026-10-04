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
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

        rooms[roomCode] = {
            players: [socket.id],
            currentQuestionIndex: 0,
            scores: { [socket.id]: 0 },
            gameQuestions: pickRandomTicket(questions),
            answers: {},
            rematchVotes: {},
            rematchTimer: null
        };

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('Создана комната:', roomCode);
    });

    // --- ПОДКЛЮЧЕНИЕ К КОМНАТЕ ---
    socket.on('joinRoom', (roomCode) => {
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('errorMessage', 'Комната не найдена');
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('errorMessage', 'Комната заполнена');
            return;
        }

        room.players.push(socket.id);
        room.scores[socket.id] = 0;
        socket.join(roomCode);

        console.log('Игрок вошёл в комнату:', roomCode);

        startNewRound(roomCode);
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

        socket.to(roomCode).emit('opponentAnswered');

        if (Object.keys(room.answers).length === room.players.length) {
            endRound(roomCode);
        }
    });

    // --- ЗАПРОС РЕВАНША ---
    socket.on('requestRematch', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.rematchVotes[socket.id] = true;
        console.log('Реванш запрошен игроком:', socket.id, 'Голоса:', room.rematchVotes);

        // Сообщаем сопернику, что кто-то ждёт
        socket.to(roomCode).emit('rematchWaiting');

        // Если оба готовы — стартуем
        if (Object.keys(room.rematchVotes).length === room.players.length) {
            if (room.rematchTimer) {
                clearTimeout(room.rematchTimer);
                room.rematchTimer = null;
            }
            startRematch(roomCode);
        } else {
            // Запускаем тайм-аут, если ещё нет
            if (!room.rematchTimer) {
                room.rematchTimer = setTimeout(() => {
                    const r = rooms[roomCode];
                    if (!r) return;
                    console.log('Реванш не состоялся — тайм-аут');
                    io.to(roomCode).emit('rematchCanceled', 'Соперник не ответил. Возвращаемся в меню.');
                    cleanupRoom(roomCode);
                }, 30000);
            }
        }
    });

    // --- ОТМЕНА РЕВАНША (уход в меню) ---
        socket.on('cancelRematch', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        console.log('Реванш отменён игроком:', socket.id);

        if (room.rematchTimer) {
            clearTimeout(room.rematchTimer);
            room.rematchTimer = null;
        }

        // Уведомляем ТОЛЬКО соперника (не себя)
        socket.to(roomCode).emit('rematchCanceled', 'Соперник отказался от реванша.');

        cleanupRoom(roomCode);
    });

    // --- ОТКЛЮЧЕНИЕ ---
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

            if (score1 > score2) {
                io.to(id1).emit('youWon', { myScore: score1, opponentScore: score2 });
                io.to(id2).emit('youLost', { myScore: score2, opponentScore: score1 });
            } else if (score2 > score1) {
                io.to(id2).emit('youWon', { myScore: score2, opponentScore: score1 });
                io.to(id1).emit('youLost', { myScore: score1, opponentScore: score2 });
            } else {
                io.to(id1).emit('youTied', { myScore: score1, opponentScore: score2 });
                io.to(id2).emit('youTied', { myScore: score2, opponentScore: score1 });
            }
            // Комната не удаляется — ждём решения о реванше
        }
    }, 2500);
}

function startRematch(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    console.log('Стартуем реванш в комнате:', roomCode);

    // Сбрасываем состояние
    room.currentQuestionIndex = 0;
    room.answers = {};
    room.rematchVotes = {};
    room.rematchTimer = null;

    // Сбрасываем счёт и перемешиваем вопросы
    room.players.forEach(id => { room.scores[id] = 0; });
    room.gameQuestions = pickRandomTicket(questions);

    io.to(roomCode).emit('rematchStarting');

    // Небольшая пауза, чтобы клиенты успели скрыть финальный экран
    setTimeout(() => {
        startNewRound(roomCode);
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
// Выбирает один случайный билет и возвращает его вопросы
function pickRandomTicket(allQuestions) {
    // Собираем все уникальные номера билетов
    const ticketNumbers = [...new Set(allQuestions.map(q => q.ticket))];
    // Берём случайный
    const randomTicket = ticketNumbers[Math.floor(Math.random() * ticketNumbers.length)];
    // Возвращаем вопросы только этого билета
    return allQuestions.filter(q => q.ticket === randomTicket);
}
server.listen(process.env.PORT || 3000, () => {
    console.log('✅ Сервер запущен! Открой в браузере: http://localhost:3000');
});