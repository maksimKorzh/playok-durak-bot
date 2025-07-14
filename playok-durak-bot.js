const WebSocket = require('ws');
const prompt = require('prompt-sync')()
const fs = require('fs');
const path = require('path');

const logFile = fs.createWriteStream(path.join(__dirname, 'botlog.txt'), { flags: 'a' });
const originalLog = console.log;

var joinedTable = 0;
var activeGame = 0;
var TABLE = 0;

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
  if (rank == undefined) {
    console.log('ERROR CARD:', card);
    process.exit();
  } return rank+suit;
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
      case 11: // playout attack/deffense cards
        for (let j=i+2; j <= i+1+board[i+1]; j++) {
          if (board[j] >= 24 && board[j] <= 115)
            playout.push(decodeCard(board[j]));
        }
        break;
      case 13: // cards in hand
        if (board[i+1] == 1) {
          for (let j=i+4; j <= i+3+board[i+3]; j++) {
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
  console.log('ATTACK:', playout, hand, trump);
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
  console.log('DEFEND:', playout, hand, trump);
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
  console.log('defenders:', validDefenders);
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
      console.log('playok: joined table #' + table);
      break;
    case 'leave':
      console.log('playok: leaving table #' + table);
      request.i = [73, table];
      TABLE = 0;
      joinedTable = 0;
      activeGame = 0;
      break;
    case 'player2':
      request.i = [83, table, 1];
      console.log('playok: took player2 place at table #' + table);
      break;
    case 'player1':
      request.i = [83, table, 0];
      console.log('playok: took player1 place at table #' + table);
      break;
    case 'start':
      activeGame = 0;
      request.i = [85, table];
      console.log('playok: attempting to start a game at table #' + table);
      setTimeout(function() {
        if (!activeGame) {
          console.log('playok: opponent refused to start game at table #' + table);
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
      console.log('playok: login failed');
      login();
    } else {
      console.log('playok: logged in as "' + username + '"');
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
        ksession,
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
    console.log('playok: connected to websocket');
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
      if (player1 != 'cft7821g') return;

      // 2 players
      if (response.i[5] == 3 && response.i[6] == 3) {
        //if (response.s[0].includes('+')) return; // no adding cards
        console.log(table, player1, player2)
        if (response.i[3] == 1 && response.i[4] == 0) acceptChallenge(socket, 'player2', table);
        if (response.i[3] == 0 && response.i[4] == 1) acceptChallenge(socket, 'player1', table);
      }
    }
    
    if (response.i[0] == 90) {
      let position = decodePosition(response.i);
      console.log('response 90:', response.i);
      if (response.i[3] == -1) activeGame = 0;
      else {
        activeGame = 1;
        if (response.i[3]) {
          let move = '';
          if (response.i[response.i.length-7] == 1) move = defend(position.playout, position.hand, position.trump);
          if (response.i[response.i.length-7] == 0) move = attack(position.playout, position.hand, position.trump);
          console.log('generated move:', move);
          let message = {};
          if (move == 'pass') {
            message = {"i":[92,TABLE,8,0,0]}
            message = JSON.stringify(message);
            console.log(message);
          } else {
            let card = encodeCard(move);
            move = {"i": [92, TABLE, 8, 0, (card+128)&-5, 0]};
            message = JSON.stringify(move);
            console.log(message);
          }
          setTimeout(function () { socket.send(message); }, 1000);
        }
      }
    }

    if (response.i[0] == 81 && response.i[1] == TABLE) { // chat messages & system notifications
      console.log('\n\n\n\n\n(CHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT) ' + response.s[0]);
      if (response.s[0].includes('loses') ||
          response.s[0].includes('exceeded')) {
          message(socket, 'leave', TABLE);
        }
    }
  });
  socket.on('error', function (error) { console.log('playok: error'); });
  socket.on('close', function () {
    console.log('playok: websocket connection closed');
    process.exit();
  }); return socket;
}

//process.on('SIGINT', function() { // Ctrl-C: force resign, Ctrl-\ to quit (linux)
//});

//setInterval(function() {
//}, 60000)

login();
//console.log(encodeCard('9c'))
//console.log(encodeCard('10d'))

//let move = defend(['7s', '8s'], ['10d', '10s', 'Jc'], '8h');
//console.log(move);

//let card = decodeCard(65) // 8d
//console.log(card)
//
//let r = [
//  90,  119, 54,  1,  8,  3,  8,   1, 1872, -1,  10,
//   1, 1640, 11, 11, 75, 99, 74,  56,   98, 64,  57,
//  72,   97, 88, 89, 15,  0, 12,   0,   13,  0,  12,
//   0,   13,  1,  1,  1, 58, 13,   2,    0,  0,  13,
//   3,    0,  0, 14,  0,  2,  1,   5,    1,  1,   1,
//   0,    0,  3,  1,  2,  5,  0, 325,    0,  0, 374,
//   1,    0,  0,  0,  0,  0,  0
//]
//let p = decodePosition(r)
//console.log(p)
//
//let move = defend(p.playout, p.hand, p.trump);
//console.log(move);
