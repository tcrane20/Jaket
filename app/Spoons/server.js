// Setting everything up
var http = require("http");
var express = require("express");
var bodyParser = require("body-parser");
var cookieParser = require("cookie-parser");
var expressSession = require("express-session");
var app = express();

var myCookieParser = cookieParser("f4tk4t4u");
var sessionStore = new expressSession.MemoryStore();

var redis = require("redis");
var rdb = redis.createClient();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(myCookieParser);
app.use(expressSession({
	secret: "f4tk4t4u",
	store: sessionStore,
	resave: true,
	saveUninitialized: true
}));

var server = http.Server(app);
var socketIO = require("socket.io");
var io = socketIO(server);

var SessionSockets = require("session.socket.io");
var sessionSockets = new SessionSockets(io, sessionStore, myCookieParser);

// Loads index.html inside /client folder
app.use(express.static(__dirname + "/client")); // Apparently this line has to be here for sessions to work. Took 7 hours to figure that out.

/////////////////////////////////////////////////////////////////////////////////////////////////////

// Maximum number of players per room. Games can start with fewer players if 30 second timer goes up.
var MAX_PLAYERS = 3;


var openRoomID = 0; // Current room index that is accepting players
var waitTime = 0;   // Amount of time remaining in the open room before a game forcibly starts
// Collection of all existing rooms. Holds list of users connected to it, number of spoons on table, and a personal timer element.
var rooms = {"0": {"users": {}, "spoons": [], "timerRunning": false}};  
// Collection of connected sockets. Format: USERNAME => SOCKET
var userToSocket = {};

//=============================================================================
// Creating a standard 52 deck of cards
//=============================================================================

// Initialize deck of cards.
var deckSchema = {
	suits: ["s", "c", "d", "h"],
	values: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k", "a"]
};

var initDeck = function (deck) {
	var i, k,
		retDeck = [],
		lenSuits = deck.suits.length,
		lenVals = deck.values.length;

	for(i = 0; i < lenSuits; i++) {
		for(k = 0; k < lenVals; k++) {
			retDeck.push({ suit:deck.suits[i], value:deck.values[k] });
		}
	}
	return(retDeck);
};

// Array shuffle function. Used to shuffle deck of cards.
// Source: http://jsfromhell.com/array/shuffle
var shuffle = function (o) {
	for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
	return o;
};

var baseDeck = initDeck(deckSchema); // Deck Initialized

// A new shuffled deck is created. The slice(0) ensures a clone of baseDeck so that baseDeck is not modified by the sort.
//var shuffledDeck = shuffle(baseDeck.slice(0)); 

//=============================================================================
// General methods
//=============================================================================

// Creates a new array of length "size" filled with the integer 1. Used for making an instance of spoons in the room.
function newOnesArray(size){
	return new Array(size+1).join('1').split('').map(parseFloat);
}

// Removes the first spoon available in the room. Needed for when a user disconnects from the game.
function removeSomeSpoon(roomid){
	var room = rooms[roomid],
		spoons = room.spoons;
	for (var i = 0; i < spoons.length; i++){
		// There is a spoon here
		if (spoons[i]){
			spoons[i] = 0;
			// Tell the users this spoon is gone now
			io.emit("removeSpoon", i, null);
			break;
		}
	}
}

// How many spoons are left on the table?
function numberOfSpoons(roomid){
	var room = rooms[roomid],
		spoons = room.spoons,
		count = 0;
	for (var i = 0; i < spoons.length; i++){
		// There is a spoon here
		if (spoons[i]){
			count++;
		}
	}
	return count;
}

// Return true if all 4 cards in the hand have the same value
function fourOfKind(cards){
	var card = cards[0],
		value = card.value;
	for (var i = 1; i < 4; i++){
		card = cards[i];
		if (card.value !== value)
			return false;
	}
	return true;
}

// Close the waiting room and prepare for a new game
function closeRoom(){
	var room = rooms[openRoomID],
		users = room.users,
		usernames = Object.keys(users),
		user,
		username;
	// Set the number of spoons in the room
	room.spoons = newOnesArray(usernames.length - 1);

	for (var i = 0; i < usernames.length; i++){
		username = usernames[0];
		usernames.push(usernames.shift());
		userToSocket[username].emit("gameStart");
		userToSocket[username].emit("usersInRoom", usernames);
	}

	/*// Send messages to all users in the room
	usernames.forEach(function (uname, index, users){

		sock = userToSocket[uname];
		sock.emit("playerIndex", index);
		sock.emit("gameStart", users.length - 1);
		sock.emit("usersInRoom", users);
	});
	*/
	// Prepare the cards for the room
	prepGame(openRoomID);

	openRoomID++;
	rooms[openRoomID] = {"users": {}, "spoons": [], "timerRunning": false};
}

// Prepares the game by shuffling the deck and dealing out cards
function prepGame(roomID){
	var room = rooms[roomID],
		users = room.users,
		usernames = Object.keys(users);
	var deck = shuffle(baseDeck.slice(0));

	// Deal out the players' hands and resets variables
	for (var i = 0; i < usernames.length; i++){
		var name = usernames[i],
			user = users[name];
		user.hand = deck.splice(0,4);
		user.pile = [];
		user.hasSpoon = false;
		// Alert player of their hand and start the timer for when the game will begin
		userToSocket[name].emit("playerHand", user.hand);
		userToSocket[name].emit("time", 5);
	}
	// Tell players how many spoons there are
	io.emit("numOfSpoons", usernames.length - 1);
	// Give remaining deck to first player's pile (the dealer)
	var dealerName = usernames[0],
		dealer = users[dealerName];
	dealer.pile = deck;
	userToSocket[dealerName].emit("updatePile", false);
	// Set room timer to 5 seconds, indicating how long of a wait until game starts
	room.timerRunning = true;
	setTimeout(turnOffTimer(roomID), 5000);
}

// Round has finished. Send results of the round to the users. The game is complete if two or fewer users remain by the time this is called.
function gameover(roomid){
	var room = rooms[roomid],
		users = room.users,
		usernames = Object.keys(users),
		user;
	// If only one user in this room, win by default (caused when all other players disconnect)
	if (usernames.length === 1){
		userToSocket[usernames[0]].emit("gameresult", null, null, true);
	} else {
		// Evaluate each user to find the one who did not get the spoon
		var i = 0,
			j = 0;
		for (i; i < usernames.length; i++){
			user = users[usernames[i]];
			if (!user.hasSpoon){
				break;
			}
		}
		var gameComplete = (usernames.length === 2);
		// Now tell the players the results
		for (j; j < usernames.length; j++){
			var uname = usernames[j];
			userToSocket[uname].emit("gameresult", usernames[i], gameComplete);
			// If this is the losing player, delete them from the room
			if (j === i)
				delete users[uname];
		}
		// Set room timer to 8 seconds, indicating how long of a wait until next round
		// Note that I don't need to send the "time" message as this is handled client-side in the "gameresult" message
		room.timerRunning = true;
		setTimeout(nextRound(roomid), 8000);
	}
}

// After having set a timer on for the room, turn it off with this method called in a setTimeout
// This is needed to start the game. Alert the users that the game has started too.
function turnOffTimer(roomid){
	rooms[roomid].timerRunning = false;
}

// The brief pause between each round. Preps for the next round
function nextRound(roomid){
	var room = rooms[roomid],
		users = room.users,
		usernames = Object.keys(users);
	// Move the previous dealer to the end of the users list by removing and adding back into the JSON. This makes the next user the dealer!
	var lastDealer = users[usernames[0]];
	delete users[usernames[0]];
	users[usernames[0]] = lastDealer;
	// Now make the preparations for the next game
	prepGame(roomid);
}

//=============================================================================
// Socket.IO
//=============================================================================

// Server receives connection from a client
sessionSockets.on("connection", function (err, socket, session){
	//--[ Note ]--------------------------------------------
	// Create data for session: session.<var> = <obj>
	// Then save the data for the session: session.save()
	//------------------------------------------------------

	console.log("some client connected; username: " + session.username);

	// ***** SOCKET.ON("USERNAME", ...) ***** BEGIN
	// Client, with accepted username, is looking for a room to join
	console.log("user " + session.username + " connected.");
	// Associate username with socket object
	userToSocket[session.username] = socket;
	// Save user session by initalizing data
	session.room = openRoomID;
	session.uid = socket.id;
	session.save();

	
	var userData = {hand: [], pile: [], hasSpoon: false};

	// Add user session to the open room
	rooms[openRoomID].users[session.username] = userData;
	// If room is full now
	var roomsize = Object.keys(rooms[openRoomID].users).length;
	if (roomsize === MAX_PLAYERS){
		// Close the room and start the game
		closeRoom();
	} else {
		// If more than one player waiting in the room, reset the timer back to 30 seconds
		if (roomsize > 1) {
			waitTime = 30;
		} else { // Only one user here so stop the timer
			waitTime = 0;
		}
		// Send message to all users in the room
		Object.keys(rooms[openRoomID].users).forEach(function (user, index, users){
			userToSocket[user].emit("usersInRoom", users);
			userToSocket[user].emit("time", waitTime);
		});
	}
	// ***** SOCKET.ON("USERNAME", ...) ***** END

	// Client disconnects
	socket.on("disconnect", function(){
		// If the user didn't input a name, don't process any further
		if (!session.username) return;

		console.log(session.username + " disconnected with socket id: " + socket.id);
		// Delete presence of the username being logged in
		delete userToSocket[session.username];
		// Get the room this user was in and its players
		var roomid = session.room,
			room = rooms[roomid],
			users = room.users,
			usernames = Object.keys(users),
			user = users[session.username];

		// Check if currently in game
		if (roomid !== openRoomID){
			console.log("In game");
			// Check if in the setup phase of the game (timer is counting down)
			if (room.timerRunning){
				console.log("Timer was running");
				// If the player was the dealer (first person in users array)
				if (usernames[0] === session.username){
					// Their hand and pile will shift to the next user
					users[usernames[1]].pile = users[usernames[1]].pile.concat(user.hand, user.pile);
				} else { 
					// The player's hand will be sent to the dealer
					users[0].pile = users[0].pile.concat(user.hand);
				}
			} else { // Currently IN game
				console.log("Game is in progress");
				// Put player's pile and hand into next person's pile
				var seatid = usernames.indexOf(session.username),
					nextseatid = (seatid + 1) % usernames.length,
					nextplayer = users[usernames[nextseatid]];
				nextplayer.pile = nextplayer.pile.concat(user.hand, user.pile);
				// The player should be aware that their pile is loaded now
				userToSocket[usernames[nextseatid]].emit("updatePile", false);
				// Remove a spoon from the game
				removeSomeSpoon(roomid);
				// If doing this causes the game to end, end the game
				if (numberOfSpoons(roomid) === 0) {
					console.log("Gameover from disconnect");
					gameover(roomid);
				}
			}
			// Delete the user from the room
			delete rooms[roomid].users[session.username];
		} else { // Currently in waiting room
			// No more users in the room, so we can delete it
			if (usernames.length === 0){
				delete rooms[roomid];
			} else {
				// Delete the user from the room
				delete rooms[roomid].users[session.username];
				// Send message to all users in the room about disconnect
				usernames = Object.keys(users); // Redo since we deleted a user
				usernames.forEach(function (uname, index, players){
					userToSocket[uname].emit("usersInRoom", players);
					// If only one user left, remove the timer
					if (players.length === 1)
						userToSocket[uname].emit("time", 0);
				});
			}
		}
	});

//--------------------------------------------
// In game messages
//--------------------------------------------
	// User is requesting the top card
	socket.on("reqTopCard", function (){
		var username = session.username,
			roomid = session.room,
			pile = rooms[roomid].users[username].pile;
		// Send the top card of the pile
		socket.emit("getTopCard", pile[0]);
		// Pile is now empty. Tell player this.
		if (pile.length === 1)
			socket.emit("updatePile", true);
	});

	// User chose a card to discard and pass to the player on the left
	socket.on("discard", function (index){
		var username = session.username,
			roomid = session.room,
			users = rooms[roomid].users,
			hand = users[username].hand;
			pile = users[username].pile;
		// Get the card based on the index (0-3 = hand, top = top card of pile)
		var card;
		if (index === "top"){
			card = pile.shift();
		} else {
			card = hand[index];
			// Put top card in hand
			hand[index] = pile.shift();
		}
		// Find user to the left, which should be a simple add one and modulo
		var usernames = Object.keys(users),
			playerSeat = usernames.indexOf(username),
			leftSeat = (playerSeat + 1) % usernames.length,
			leftPlayerName = usernames[leftSeat];
			playerSocket = userToSocket[leftPlayerName];
		// Put discarded card on end of pile (user.pile.push)
		users[leftPlayerName].pile.push(card);
		// At this point, if anyone's piles just changed from being empty, alert them
		// Reason for 2 instead of 1 is because when the top card is revealed, it technically is still in the pile. If the player is looking at their last card in the pile, the
		// pile will appear to be empty to them even though the pile's size is 1.
		if (users[leftPlayerName].pile.length <= 2)
			playerSocket.emit("updatePile", false);
	});

	// User is attempting to get the spoon located at some index
	socket.on("getSpoon", function (index){
		var username = session.username,
			roomid = session.room,
			users = rooms[roomid].users,
			usernames = Object.keys(users),
			spoons = rooms[roomid].spoons,
			hand = users[username].hand;
		// Don't allow taking spoon if they already have it
		if (users[username].hasSpoon){
			// DO NOTHING LOL
		// Check if 4 of a Kind in hand or if the number of spoons is not at maximum
		} else if (fourOfKind(hand) || numberOfSpoons(roomid) !== usernames.length - 1){
			// If valid, confirm taking the spoon by telling all users
			var userid = usernames.indexOf(username);
			io.emit("removeSpoon", index, userid);
			rooms[roomid].spoons[index] = 0;
			users[username].hasSpoon = true;
			// If spoons is 0, send message to end game
			if (numberOfSpoons(roomid) === 0){
				console.log("gameover from last spoon grabbed")
				gameover(roomid);
			}
		} else {
			// Otherwise, penalize the player
			socket.emit("penalty");
		}
	});


});

//=============================================================================
// Connect to Redis Database
//=============================================================================

// server establishes connection with Redis server
rdb.on("connect", function(){
	"use strict";
	console.log("Connected to Redis server");
});

//=============================================================================
// AJAX request and responses
//=============================================================================

// Defaults to the login page.
app.get("/", function (req, res) {
	"use strict";

	res.redirect("/login");
	return;
});

// If a user has logged in (isAuthorized == true), then they are directed to the maing page;
// otherwise, the user is directed to the login page.
app.get("/spoons", function (req, res) {
	if(req.session.isAuthorized) {
		res.sendFile(__dirname + "/client/default.html");
	} else {
		res.redirect("/login");
	}
	return;
});

// User requesting to register for an account; redirect to registration page.
app.get("/register", function (req, res) {
	"use strict";

	res.sendFile(__dirname + "/client/register.html");
	return;
});

// User submits their registration data and it is saved to the database.
app.post("/register", function (req, res){
	"use strict";

	console.log("Username: " + req.body.username.toLowerCase() + "\nPassword: " + req.body.password);
	// Check if the username already exists in the database
	rdb.exists(req.body.username.toLowerCase(), function (err, reply) {
		if(err) {
			console.log(err);
			return res.json({ msg:"Server was unable to complete the registration. Please try again."})
		}
		// Username exists
		if (reply === 1) {
			return res.json({ msg:"Username already exists." });
		} else {
			rdb.hmset(req.body.username.toLowerCase(), {
				"password": req.body.password,
				"rank":"0",
				"gamesPlayed": "0"
			});
			return res.json({ msg:"success" }) // We really should redirect back to home page
		}
	});
});

// When a user is directed to the login route, the login page is loaded.
app.get("/login", function (req, res) {
	"use strict";

	res.sendFile(__dirname + "/client/login.html");
	return;
});

// Logs the user out of the server by destroying their active session and redirecting to the login route.
// At this point the user would have to log in again.
app.get("/logout", function (req, res) {
	"use strict";

	req.session.destroy();
	res.redirect("/login");
	return;
});

// User requesting to login to their account
app.post("/login", function (req, res){
	"use strict";

	var un = req.body.username.toLowerCase();
	console.log("Username: " + un + "\nPassword: " + req.body.password);
	// Get username from database
	rdb.hgetall(un, function (err, user) {
		if(err) {
			console.log(err);
			return res.json({ msg:"Server was unable to complete the login. Please try again." })
		}
		// Username exists
		if (user !== null) {
			// Check that password matches
			if(user.password === req.body.password) {
				// Checking if this user isn't already logged in
				if (!userToSocket[un]){
					console.log(user);
					req.session.isAuthorized = true;
					req.session.username = un;
					req.session.rank = user.rank;
					req.session.gamesPlayed = user.gamesPlayed;
					
					return res.json({ msg:"success" });
				} else {
					return res.json({ msg:"User is already logged in." });
				}
				
			} else {
				req.session.isAuthorized = false;
				console.log("Incorrect Password - isAuthorized: " + req.session.isAuthorized);
				return res.json({ msg:"Invalid username/password." });
			}
		} else {
			req.session.isAuthorized = false;
			return res.json({ msg:"Invalid username/password." });
		}
	});
});

//=============================================================================
// Interval functions
//=============================================================================

// Wait Room timer. Decreases wait time each second and automatically starts the game if not
// enough users are connected.
setInterval(function(){
	// If more than one user in the room
	if (Object.keys(rooms[openRoomID].users).length > 1){
		// Decrease the timer. If elapsed, forcibly start the game.
		waitTime--;
		if (waitTime === 0){
			closeRoom();
		}
	}
}, 1000);



// Prints out server stats every 5 seconds. Can be removed in final version.
setInterval(function(){
	//console.log("Games in progress: " + inGameRooms.length);
	console.log("Open Room ID: " + openRoomID);
	console.log("Number of users in this room: " + Object.keys(rooms[openRoomID].users).length);
	console.log("Wait time remaining: " + waitTime);
}, 5000);


//=============================================================================
// Start-up the server
//=============================================================================

// Start the server
server.listen(3000);
console.log("Server listening on port 3000...");