const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const questions = require('./questions.json');
const fs = require('fs');
const STATS_FILE = './stats.json';

// Загружаем статистику из файла (если есть)
let stats = { totalGames: 0, gamesByDay: {} };
try {
    if (fs.existsSync(STATS_FILE)) {
        stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
} catch (e) {
    console.log('Не удалось загрузить статистику:', e);
}

// Сохраняем статистику в файл
function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.log('Не удалось сохранить статистику:', e);
    }
}

// Увеличиваем счётчик за сегодня
function incrementGamesToday() {
    const today = new Date().toISOString().slice(0, 10); // "2026-10-09"
    if (!stats.gamesByDay[today]) stats.gamesByDay[today] = 0;
    stats.gamesByDay[today]++;
    stats.totalGames++;
    saveStats();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
    console.log('Подключился игрок:', socket.id);

    // Отправляем всем актуальный онлайн
    io.emit('onlineCount', io.sockets.sockets.size);

    // --- СОЗДАНИЕ КОМНАТЫ ---
    socket.on('createRoom', ({ playerName, avatarId, mode }) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        const name = (playerName || 'Игрок').slice(0, 20);
        const avatar = avatarId || 1;
        const chosenMode = mode || 'duel';

        const ticketData = pickQuestions(chosenMode);
        
        incrementGamesToday();

        rooms[roomCode] = {
            players: [socket.id],
            names: { [socket.id]: name },
            avatars: { [socket.id]: avatar },
            scores: { [socket.id]: 0 },
            mode: chosenMode,
            answers: {},
            rematchVotes: {},
            rematchTimer: null,
            // Для duel/classic:
            gameQuestions: ticketData.questions,
            currentTicket: ticketData.ticketNumber,
            currentQuestionIndex: 0,
            // Для pick:
            playerQuestions: {},
            playerTicketNumbers: {},
            playerQuestionIndex: {},
            chosenTickets: {}
        };

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('Создана комната:', roomCode, '| Режим:', chosenMode, '| Билет:', ticketData.ticketNumber, '| Игр сегодня:', stats.gamesByDay[new Date().toISOString().slice(0, 10)]);
    });

    // --- ПОДКЛЮЧЕНИЕ К КОМНАТЕ ---
    socket.on('joinRoom', ({ roomCode, playerName, avatarId }) => {
        const room = rooms[roomCode];

        if (!room) { socket.emit('errorMessage', 'Комната не найдена'); return; }
        if (room.players.length >= 2) { socket.emit('errorMessage', 'Комната заполнена'); return; }
        if (room.players.includes(socket.id)) { socket.emit('errorMessage', 'Вы уже в этой комнате'); return; }

        const name = (playerName || 'Игрок').slice(0, 20);
        const avatar = avatarId || 1;

        room.players.push(socket.id);
        room.names[socket.id] = name;
        room.avatars[socket.id] = avatar;
        room.scores[socket.id] = 0;
        socket.join(roomCode);

        console.log('Игрок вошёл:', roomCode, '| Имя:', name, '| Режим:', room.mode);

        io.to(roomCode).emit('playersInfo', {
            names: room.names,
            avatars: room.avatars,
            players: room.players
        });

        if (room.mode === 'pick') {
            // Режим "Выбери билет сопернику"
            // Отправляем обоим экран выбора
            io.to(roomCode).emit('chooseTicketForOpponent', { ticketCount: 40 });

            // Тайм-аут 30 секунд
            room.pickTimeout = setTimeout(() => {
                const r = rooms[roomCode];
                if (!r) return;
                // Тем, кто не выбрал — случайный билет
                r.players.forEach(id => {
                    if (r.chosenTickets[id] === undefined) {
                        r.chosenTickets[id] = Math.floor(Math.random() * 40) + 1;
                        io.to(id).emit('ticketAutoChosen', { ticketNumber: r.chosenTickets[id] });
                    }
                });
                // Проверяем, все ли выбрали
                if (Object.keys(r.chosenTickets).length === r.players.length) {
                    startPickMatch(roomCode);
                }
            }, 30000);
        } else {
            // duel / classic — как раньше
            io.to(roomCode).emit('ticketChosen', { ticketNumber: room.currentTicket });
            setTimeout(() => {
                startNewRound(roomCode);
            }, 3200);
        }
    });

    // --- ВЫБОР БИЛЕТА (для pick) ---
    socket.on('chooseTicket', ({ roomCode, ticketNumber }) => {
        const room = rooms[roomCode];
        if (!room || room.mode !== 'pick') return;

        // Сохраняем выбор
        room.chosenTickets[socket.id] = ticketNumber;
        console.log('Игрок', socket.id, 'выбрал билет', ticketNumber, 'для соперника');

        // Сообщаем сопернику, что этот игрок выбрал
        socket.to(roomCode).emit('opponentPickedTicket');

        // Если оба выбрали — стартуем
        if (Object.keys(room.chosenTickets).length === room.players.length) {
            if (room.pickTimeout) {
                clearTimeout(room.pickTimeout);
                room.pickTimeout = null;
            }
            startPickMatch(roomCode);
        }
    });

    // --- ОТВЕТ НА ВОПРОС ---
    socket.on('submitAnswer', ({ roomCode, answerIndex, timeLeft }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.answers[socket.id] !== undefined) return;

        // Определяем вопрос для этого игрока
        let currentQuestion;
        if (room.mode === 'pick') {
            const qIndex = room.playerQuestionIndex[socket.id];
            currentQuestion = room.playerQuestions[socket.id][qIndex];
        } else {
            currentQuestion = room.gameQuestions[room.currentQuestionIndex];
        }

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
            if (room.rematchTimer) { clearTimeout(room.rematchTimer); room.rematchTimer = null; }
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
        if (room.rematchTimer) { clearTimeout(room.rematchTimer); room.rematchTimer = null; }
        socket.to(roomCode).emit('rematchCanceled', 'Соперник отказался от реванша.');
        cleanupRoom(roomCode);
    });

        socket.on('disconnect', () => {
        console.log('Игрок отключился:', socket.id);
        // Обновляем онлайн у всех
        io.emit('onlineCount', io.sockets.sockets.size);
    });
});

// --- ХЕЛПЕРЫ ---

// Выбирает вопросы для режима
function pickQuestions(mode) {
    const ticketNumbers = [...new Set(questions.map(q => q.ticket))];
    const randomTicket = ticketNumbers[Math.floor(Math.random() * ticketNumbers.length)];
    const ticketQuestions = questions.filter(q => q.ticket === randomTicket);

    if (mode === 'duel') {
        const shuffled = [...ticketQuestions].sort(() => 0.5 - Math.random());
        return {
            questions: shuffled.slice(0, Math.min(10, shuffled.length)),
            ticketNumber: randomTicket
        };
    } else {
        return {
            questions: [...ticketQuestions].sort((a, b) => a.number - b.number),
            ticketNumber: randomTicket
        };
    }
}

// Запуск матча в режиме pick
function startPickMatch(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const [id1, id2] = room.players;

    // id1 получит билет, выбранный id2, и наоборот
    const ticketFor1 = room.chosenTickets[id2];
    const ticketFor2 = room.chosenTickets[id1];

    // Собираем вопросы из билетов
    const questionsFor1 = questions.filter(q => q.ticket === ticketFor1).sort((a, b) => a.number - b.number);
    const questionsFor2 = questions.filter(q => q.ticket === ticketFor2).sort((a, b) => a.number - b.number);

    room.playerQuestions[id1] = questionsFor1;
    room.playerQuestions[id2] = questionsFor2;
    room.playerTicketNumbers[id1] = ticketFor1;
    room.playerTicketNumbers[id2] = ticketFor2;
    room.playerQuestionIndex[id1] = 0;
    room.playerQuestionIndex[id2] = 0;

    console.log('Режим pick — id1 получил билет', ticketFor1, ', id2 получил билет', ticketFor2);

    // Отправляем каждому его билет (с анимацией)
    io.to(id1).emit('ticketChosen', { ticketNumber: ticketFor1 });
    io.to(id2).emit('ticketChosen', { ticketNumber: ticketFor2 });

    // Через 3.2 сек — старт первого раунда
    setTimeout(() => {
        startNewRound(roomCode);
    }, 3200);
}

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.answers = {};

    if (room.mode === 'pick') {
        // Каждому — свой вопрос
        room.players.forEach(id => {
            const qIndex = room.playerQuestionIndex[id];
            const q = room.playerQuestions[id][qIndex];
            io.to(id).emit('nextQuestion', {
                question: q,
                questionNumber: qIndex + 1,
                totalQuestions: room.playerQuestions[id].length
            });
        });
    } else {
        // duel / classic — общий вопрос
        io.to(roomCode).emit('nextQuestion', {
            question: room.gameQuestions[room.currentQuestionIndex],
            questionNumber: room.currentQuestionIndex + 1,
            totalQuestions: room.gameQuestions.length
        });
    }
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Определяем правильный ответ для показа
    let correctIndex;
    if (room.mode === 'pick') {
        // У каждого свой вопрос — берём вопрос первого игрока для показа
        const firstId = room.players[0];
        const qIndex = room.playerQuestionIndex[firstId];
        correctIndex = room.playerQuestions[firstId][qIndex].correct;
    } else {
        correctIndex = room.gameQuestions[room.currentQuestionIndex].correct;
    }

    io.to(roomCode).emit('roundResult', {
        correctIndex,
        scores: room.scores,
        names: room.names,
        avatars: room.avatars,
        answers: room.answers
    });

    setTimeout(() => {
        if (room.mode === 'pick') {
            // Увеличиваем индекс у каждого
            room.players.forEach(id => {
                room.playerQuestionIndex[id]++;
            });

            const firstId = room.players[0];
            const totalQuestions = room.playerQuestions[firstId].length;
            const currentIndex = room.playerQuestionIndex[firstId];

            if (currentIndex < totalQuestions) {
                startNewRound(roomCode);
            } else {
                finishMatch(roomCode);
            }
        } else {
            room.currentQuestionIndex++;
            if (room.currentQuestionIndex < room.gameQuestions.length) {
                startNewRound(roomCode);
            } else {
                finishMatch(roomCode);
            }
        }
    }, 2500);
}

function finishMatch(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

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

function startRematch(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.answers = {};
    room.rematchVotes = {};
    room.rematchTimer = null;
    room.chosenTickets = {};

    room.players.forEach(id => { room.scores[id] = 0; });

    if (room.mode === 'pick') {
        // Сбрасываем выбор — отправим обоим экран выбора заново
        io.to(roomCode).emit('rematchStarting');
        setTimeout(() => {
            io.to(roomCode).emit('chooseTicketForOpponent', { ticketCount: 40 });
            room.pickTimeout = setTimeout(() => {
                const r = rooms[roomCode];
                if (!r) return;
                r.players.forEach(id => {
                    if (r.chosenTickets[id] === undefined) {
                        r.chosenTickets[id] = Math.floor(Math.random() * 40) + 1;
                        io.to(id).emit('ticketAutoChosen', { ticketNumber: r.chosenTickets[id] });
                    }
                });
                if (Object.keys(r.chosenTickets).length === r.players.length) {
                    startPickMatch(roomCode);
                }
            }, 30000);
        }, 500);
    } else {
        const ticketData = pickQuestions(room.mode);
        room.gameQuestions = ticketData.questions;
        room.currentTicket = ticketData.ticketNumber;
        room.currentQuestionIndex = 0;

        io.to(roomCode).emit('rematchStarting');
        setTimeout(() => {
            io.to(roomCode).emit('ticketChosen', { ticketNumber: ticketData.ticketNumber });
            setTimeout(() => {
                startNewRound(roomCode);
            }, 3200);
        }, 500);
    }
}

function cleanupRoom(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.rematchTimer) clearTimeout(room.rematchTimer);
    if (room.pickTimeout) clearTimeout(room.pickTimeout);
    delete rooms[roomCode];
}

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('✅ Сервер запущен! Открой в браузере: http://localhost:3000');
});