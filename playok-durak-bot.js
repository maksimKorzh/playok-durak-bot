const WebSocket = require('ws');
const prompt = require('prompt-sync')()
const fs = require('fs');
const path = require('path');

const logFile = fs.createWriteStream(path.join(__dirname, 'botlog.txt'), { flags: 'a' });
const originalLog = console.log;

var joinedTable = 0;
var activeGame = 0;
var TABLE = 0;
var botSide = '';

function encodeCard(card) {
  if (card == undefined) return 0;
  let suits = ['h', 'd', 'c', 's'];
  let ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let rank = ranks.indexOf(card.slice(0, card.length-1))+6;
  let suit = suits.indexOf(card[card.length-1]);
  return (rank << 3) | suit;
}

function decodeCard(card) {
  let suits = ['h', 'd', 'c', 's'];
  let ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let suit = suits[card & 7];
  let rank = ranks[(card >> 3) - 6];
  
  // remove later
  if (rank == undefined) {
    console.log('ERROR CARD:', card);
    process.exit();
  }
  
  return rank+suit;
}

function decodePosition(board) {
  let deck = board[12] >> 8;
  let trump = (((board[12] % 256) >> 3) << 3) | (board[12] % 8);
  let playout = [];
  let hand = [];
  if (trump >= 24 && trump <= 115)
    trump = decodeCard((((board[12] % 256) >> 3) << 3) | (board[12] % 8))
  else trump = '6h' // placeholder
  for (let i=0; i < board.length; i++) {
    switch (board[i]) {
      case 11: // playout cards
        for (let j=i+2; j <= i+1+board[i+1]; j++) {
          if (board[j] >= 24 && board[j] <= 115)
            playout.push(decodeCard(board[j]));
        }
        break;
      case 13: // cards in hand
        if (board[i+1] == (botSide == 'player2' ? 1 : 0)) {
          let startIndex = i+4;
          let numCards = board[i+3]-1;
          //console.log('startIndex:', startIndex, 'numCards:', numCards, 'endIndex:', startIndex + numCards);
          for (let j=startIndex; j <= startIndex + numCards; j++) {
            //console.log('decode:', j, board[i+3], board[j]);
            if (board[j] < 24 || board[j] > 115) break;
            if (board[j] >= 24 && board[j] <= 115)
              hand.push(decodeCard(board[j]));
          }
        }
        break;
    }
  } return {
    deck: deck,
    trump: trump,
    playout: playout,
    hand: hand
  }
}

function attack(playout, hand, trump) {
  console.log('attack:', playout, hand, trump);
  const rankOrder = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
  const trumpSuit = trump.slice(-1);
  const getRank = card => card.length === 3 ? card.slice(0, 2) : card[0];
  const getSuit = card => card.slice(-1);
  const isTrump = card => getSuit(card) === trumpSuit;
  const sortByRank = cards => cards.slice().sort(
    (a, b) => rankOrder[getRank(a)] - rankOrder[getRank(b)]
  );
  if (playout.length === 0) {
    const nonTrumps = hand.filter(c => !isTrump(c));
    if (nonTrumps.length) return sortByRank(nonTrumps)[0];
    return sortByRank(hand)[0]; // all are trumps
  }
  const playoutRanks = playout.map(getRank);
  const valid = hand.filter(c => playoutRanks.includes(getRank(c)));
  const nonTrumps = valid.filter(c => !isTrump(c));
  const allNonTrumps = hand.filter(c => c.slice(-1) !== trump.slice(-1));
  if (nonTrumps.length) return sortByRank(nonTrumps)[0];
  const trumps = valid.filter(isTrump);
  if (trumps.length && !allNonTrumps.length) return sortByRank(trumps)[0];
  return 'pass';
}

function defend(playout, hand, trump) {
  console.log('deffend:', playout, hand, trump);
  const rankOrder = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
  const getRank = card => card.length === 3 ? card.slice(0, 2) : card[0];
  const getSuit = card => card.slice(-1);
  const isTrump = card => getSuit(card) === trump.slice(-1);
  if (playout.length === 0) return 'pass'; // nothing to defend
  const attackCard = playout[playout.length - 1];
  const attackRank = rankOrder[getRank(attackCard)];
  const attackSuit = getSuit(attackCard);
  const attackIsTrump = isTrump(attackCard);
  const validDefenders = hand.filter(card => {
    const suit = getSuit(card);
    const rank = rankOrder[getRank(card)];
    if (suit === attackSuit && rank > attackRank) return true; // higher same-suit beats
    if (isTrump(card) && attackIsTrump && rank > attackRank) return true; // higher trump beats lower trump
    if (isTrump(card) && !attackIsTrump) return true; // any trump beats non-trump
    return false;
  });
  if (validDefenders.length === 0) return 'pass';
  validDefenders.sort((a, b) => rankOrder[getRank(a)] - rankOrder[getRank(b)]);
  if (isTrump(validDefenders[0])) {
    for (let i of validDefenders)
      if (!isTrump(i)) return i;
  }
  return validDefenders[0];
}

console.log = function (...args) {
  const message = args.map(arg => {
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  }).join(' ');
  originalLog.apply(console, args);
  logFile.write(message + '\n');
};

function acceptChallenge(socket, color, table) {
  message(socket, 'join', table);
  message(socket, color, table);
  message(socket, 'start', table);
}

function message(socket, action, table) {
  let request = {"i": [], "s": []};
  switch (action) {
    case 'join':
      request.i = [72, table];
      TABLE = table;
      joinedTable = 1;
      console.log('joined table #' + table);
      break;
    case 'leave':
      console.log('leaving table #' + table);
      request.i = [73, table];
      TABLE = 0;
      joinedTable = 0;
      activeGame = 0;
      botSide = '';
      break;
    case 'player2':
      request.i = [83, table, 1];
      console.log('took player2 place at table #' + table);
      botSide = 'player2';
      break;
    case 'player1':
      request.i = [83, table, 0];
      console.log('took player1 place at table #' + table);
      botSide = 'player1';
      break;
    case 'start':
      activeGame = 0;
      request.i = [85, table];
      console.log('attempting to start a game at table #' + table);
      setTimeout(function() {
        if (!activeGame) {
          console.log('opponent refused to start game at table #' + table);
          message(socket, 'leave', table);
        }
      }, 5000);
      break;
    case 'resign':
      request.i = [93, table, 4, 0];
      break;
    case 'pass':
      request.i = [92, table, 0, 400, 0];
      break;
  } socket.send(JSON.stringify(request));
}

function login() {
  var username = prompt('Username: ')
  var password = prompt('Password: ', { echo: '' })
  const axios = require('axios');
  const tough = require('tough-cookie');
  const { wrapper } = require('axios-cookiejar-support');
  (async () => {
    const cookieJar = new tough.CookieJar();
    const client = wrapper(axios.create({
      jar: cookieJar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Referer': 'https://www.playok.com/en/',
      }
    }));

    await cookieJar.setCookie('ref=https://www.playok.com/en/go/; Domain=www.playok.com; Path=/', 'https://www.playok.com');

    const data = new URLSearchParams({
      username: username,
      pw: password,
    }).toString();
  
    const response = await client.post('https://www.playok.com/en/login.phtml', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  
    const cookies = await cookieJar.getCookies('https://www.playok.com');
    
    if (response.data.toLowerCase().includes('log in')) {
      console.log('login failed');
      login();
    } else {
      console.log('logged in as "' + username + '"');
      cookies.forEach(function(c) { if (c.key == 'ksession') socket = connect(c.value.split(':')[0]); });
    }
  })();
}

function connect(ksession) {
  const socket = new WebSocket('wss:x.playok.com:17003/ws/', {
    headers: {
     'Origin': 'null',
    }
  });
  socket.on('open', function () {
    const initialMessage = JSON.stringify({
      "i":[1742],
      "s":[
        //ksession,
        "+442266185138966324|1249210350|15421574", //  tgb6968g
        "en",
        "b",
        "",
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        "/1752384256531/1",
        "w","1920x1080 1",
        "ref:https://www.playok.com/en/durak/","ver:263"
      ]}
    );
    socket.send(initialMessage);
    console.log('connected to websocket');
    setInterval(function() {
      const keepAliveMessage = JSON.stringify({ "i": [] });
      socket.send(keepAliveMessage);
    }, 5000);
  });
  socket.on('message', function (data) {
    let response = JSON.parse(data);
    if (response.i[0] == 70) { // lobby & pairing
      let table = response.i[1];
      let player1 = response.s[1];
      let player2 = response.s[2];
      if (joinedTable == 1) return;
   
      // DEBUG
      //if (player1 != 'cft7821g') return;

      // 2 players
      if (response.i[5] == 3 && response.i[6] == 3) {
        if (response.i[3] == 1 && response.i[4] == 0) acceptChallenge(socket, 'player2', table);
        if (response.i[3] == 0 && response.i[4] == 1) acceptChallenge(socket, 'player1', table);
      }
    }
    
    if (response.i[0] == 81 && response.i[1] == TABLE) { // chat messages & system notifications
      if (response.s[0].includes('exceeded') ||
          response.s[0].includes('booted') ||
          response.s[0].includes('offline') ||
          response.s[0].includes('displaced')) {
            console.log(response.s[0]);
            message(socket, 'leave', response.i[1]);
          }
    }
    
    if (response.i[0] == 90) {
      let position = decodePosition(response.i);
      if (response.i[3] == -1) {
        activeGame = 0;
      } else {
        activeGame = 1;
        console.log(response.i);
        if (response.i[3] == (botSide == 'player1' ? 0 : 1)) { // == 1 for player2
          let move = '';
          if (response.i[response.i.length-7] == (botSide == 'player1' ? 0 : 1)) move = defend(position.playout, position.hand, position.trump);  // == 1 for player2
          if (response.i[response.i.length-7] == (botSide == 'player1' ? 1 : 0)) move = attack(position.playout, position.hand, position.trump);  // == 0 for player1
          console.log('generated move', move);
          if (move == undefined) process.exit();
          let message = {};
          if (move == 'pass') {
            message = {"i":[92,TABLE,8,0,0]}
            message = JSON.stringify(message);
          } else {
            let card = encodeCard(move);
            if (botSide == 'player2') card += 128;
            move = {"i": [92, TABLE, 8, 0, (card&-5), 0]};
            message = JSON.stringify(move);
          }
          setTimeout(function () {
            console.log('sending:', message);
            socket.send(message);
          }, 1);
        }
      }
    }
  });
  socket.on('error', function (error) { console.log('websocket error'); });
  socket.on('close', function () {
    console.log('websocket connection closed');
    process.exit();
  }); return socket;
}

function debug() {
  let player2 = [
    90,  108, 48, 1,   8,   3,  0,  1, 2100, -1,  10,
     1, 6194, 11, 0,  15,   0, 12,  0,   13,  0,   6,
     0,   13,  1, 6,   6, 112, 90, 82,   66, 97, 115,
    13,    2,  0, 0,  13,   3,  0,  0,   14,  0,   0,
     1,    5,  1, 1,   1,   1,  0,  3,    1,  2,   5,
     0,  420,  1, 0, 420,   0,  0,  0,    0,  0,   0,
     0
  ];
  
  let player1 = [
  90, 133,   43,  1,   8,   3,   0,   1, 1303, -1,
  10,   1, 2401, 11,   3, 106, 114, 112,   15,  0,
  12,   0,   13,  0,   8,   8, 104,  96,   80, 64,
  98,  82,   74, 66,  13,   1,   4,   0,   13,  2,
   0,   0,   13,  3,   0,   0,   3,   1,    2,  5,
   0, 377,    1,  1, 261,   0,   0,   0,    0,  0,
   0,   0
  ];
                    
  
  let p = decodePosition(player1)
  console.log('POSITION:', p)
  
  let move = defend(p.playout, p.hand, p.trump);
}

setInterval(function() {
  // Leave after game ends
  if (joinedTable == 1 && activeGame == 0 && TABLE) {
    console.log('finished game at table #' + TABLE);
    message(socket, 'leave', TABLE);
  }
}, 1000)

//debug();
socket = connect();
//login();
