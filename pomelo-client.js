var WebSocket = require('ws');
var EventEmitter = require('events').EventEmitter;
var protocol = require('pomelo-protocol');
var protobuf = require('pomelo-protobuf');
var Package = protocol.Package;
var Message = protocol.Message;
var logger = require('pomelo-logger').getLogger();

if (typeof Object.create !== 'function') {
  Object.create = function (o) {
    function F() {}
    F.prototype = o;
    return new F();
  };
}

var JS_WS_CLIENT_TYPE = 'js-websocket';
var JS_WS_CLIENT_VERSION = '0.0.1';

var RES_OK = 200;
var RES_OLD_CLIENT = 501;

var pomelo = Object.create(EventEmitter.prototype); // object extend from object
var socket = null;
var reqId = 0;
var callbacks = {};
var handlers = {};
var routeMap = {};

var heartbeatInterval = 5000;
var heartbeatTimeout = heartbeatInterval * 2;
var nextHeartbeatTimeout = 0;
var gapThreshold = 100; // heartbeat gap threshold
var heartbeatId = null;
var heartbeatTimeoutId = null;

var handshakeCallback = null;

var handshakeBuffer = {
	'sys':{
		type: JS_WS_CLIENT_TYPE,
		version: JS_WS_CLIENT_VERSION
	},
	'user':{
	}
};

var initCallback = null;

module.exports = pomelo;
//初始化
pomelo.init = function(params, cb){
	pomelo.debug = !!params.debug;
	initCallback = cb;
	var host = params.host;
	var port = params.port;
		
	//没看懂
	var url = 'ws://' + host;
	if(port) {
		url +=  ':' + port;
	}
	
	if(pomelo.debug)
		logger.info('init websocket, params : %s',JSON.stringify(params));
	
	handshakeBuffer.user = params.user;
	handshakeCallback = params.handshakeCallback;
	initWebSocket(url,cb);
};
pomelo.request = function(route, msg, cb) {
	msg = msg || {};
	route = route || msg.route;
	if(!route) {
		pomelo.emit('io-error', 'fail to send request without route.');
		return;
	}
	reqId++;
	sendMessage(reqId, route, msg);

	callbacks[reqId] = cb;
	routeMap[reqId] = route;
};
pomelo.disconnect = function() {
	if(socket) {
		if(socket.disconnect) 
			socket.disconnect();
		if(socket.close) 
			socket.close();
		if(pomelo.debug)
			logger.info('disconnect!');
		socket = null;
	}

	if(heartbeatId) {
		clearTimeout(heartbeatId);
		heartbeatId = null;
	}
	if(heartbeatTimeoutId) {
		clearTimeout(heartbeatTimeoutId);
		heartbeatTimeoutId = null;
	}
};
pomelo.notify = function(route, msg) {
	msg = msg || {};
	sendMessage(0, route, msg);
};
var initWebSocket = function(url,cb){
	var onopen = function(event){
		if(pomelo.debug)
			logger.info('socket is open!');
		
		var obj = Package.encode(Package.TYPE_HANDSHAKE, protocol.strencode(JSON.stringify(handshakeBuffer)));
		send(obj);
	};
	var onmessage = function(event) {
		if(pomelo.debug)
			logger.info('get message:%s',Package.decode(event.data));
		processPackage(Package.decode(event.data), cb);	
		if(heartbeatTimeout) {
			nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
		}
	};
	var onerror = function(event) {
		pomelo.emit('io-error', event);
	};
	var onclose = function(event){
		pomelo.emit('close',event);
	};
	
	socket = new WebSocket(url);
	socket.binaryType = 'arraybuffer';
	socket.onopen = onopen;
	socket.onmessage = onmessage;
	socket.onerror = onerror;
	socket.onclose = onclose;
};
var send = function(packet){
	if (!!socket) {
		socket.send(packet.buffer || packet, {binary: true, mask: true});
	}
	else {
		pomelo.emit('error', 'socket is wrong!');
	}
};
var sendMessage = function(reqId, route, msg) {
	//reqId不为0就是requeste否则是notify
	var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

	//compress message by protobuf
	logger.info(pomelo.data);
	var protos = !!pomelo.data.protos ? pomelo.data.protos.client : {};
	if(!!protos[route]){
		msg = protobuf.encode(route, msg);
	}else{
		msg = protocol.strencode(JSON.stringify(msg));
	}

	var compressRoute = 0;
	if(pomelo.dict && pomelo.dict[route]){
		route = pomelo.dict[route];
		compressRoute = 1;
	}

	msg = Message.encode(reqId, type, compressRoute, route, msg);
	var packet = Package.encode(Package.TYPE_DATA, msg);
	send(packet);
};
var heartbeat = function(data) {
	var obj = Package.encode(Package.TYPE_HEARTBEAT);
	if(heartbeatTimeoutId) {
		clearTimeout(heartbeatTimeoutId);
		heartbeatTimeoutId = null;
	}

	if(heartbeatId) {
		// already in a heartbeat interval
		return;
	}

	heartbeatId = setTimeout(function() {
		heartbeatId = null;
		send(obj);

		nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
		heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, heartbeatTimeout);
	}, heartbeatInterval);
};
var heartbeatTimeoutCb = function() {
	var gap = nextHeartbeatTimeout - Date.now();
	if(gap > gapThreshold) {
		heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, gap);
	} else {
		console.error('server heartbeat timeout');
		pomelo.emit('heartbeat timeout');
		pomelo.disconnect();
	}
};
var handshake = function(data){
	if(pomelo.debug)
		logger.info('handshake data is %s',protocol.strdecode(data));
	data = JSON.parse(protocol.strdecode(data));
	if(data.code === RES_OLD_CLIENT) {
		pomelo.emit('error', 'client version not fullfill');
		return;
	}

	if(data.code !== RES_OK) {
		pomelo.emit('error', 'handshake fail');
		return;
	}
	handshakeInit(data);

	var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
	send(obj);
	if(initCallback) {
		initCallback(socket);
		initCallback = null;
	}
};
var onData = function(data){
	//probuff decode
	var msg = Message.decode(data);

	if(msg.id > 0){
		msg.route = routeMap[msg.id];
		delete routeMap[msg.id];
		if(!msg.route){
			return;
		}
	}

	msg.body = deCompose(msg);
	processMessage(pomelo, msg);
};
var deCompose = function(msg){
	var protos = !!pomelo.data.protos ? pomelo.data.protos.server : {};
	var abbrs = pomelo.data.abbrs;
	var route = msg.route;

	try {
    //Decompose route from dict
		if(msg.compressRoute) {
			if(!abbrs[route]){
				console.error('illegal msg!');
			return {};
		}

		route = msg.route = abbrs[route];
		}
		if(!!protos[route]){
			return protobuf.decode(route, msg.body);
		}else{
			return JSON.parse(protocol.strdecode(msg.body));
		}
	} catch(ex) {
		console.error('route, body = ' + route + ", " + msg.body);
	}

	return msg;
};
var processMessage = function(pomelo, msg) {
	if(!msg || !msg.id) {
		// server push message
		// console.error('processMessage error!!!');
		pomelo.emit(msg.route, msg.body);
		return;
	}
	//if have a id then find the callback function with the request
	var cb = callbacks[msg.id];

	delete callbacks[msg.id];
	if(typeof cb !== 'function') {
		return;
	}
	//调用回调函数
	cb(msg.body);
	return;
};
var onKick = function(data) {
	pomelo.emit('onKick');
};
handlers[Package.TYPE_HANDSHAKE] = handshake;
handlers[Package.TYPE_HEARTBEAT] = heartbeat;
handlers[Package.TYPE_DATA] = onData;
handlers[Package.TYPE_KICK] = onKick;

/*
Package.TYPE_HANDSHAKE = 1;
Package.TYPE_HANDSHAKE_ACK = 2;
Package.TYPE_HEARTBEAT = 3;
Package.TYPE_DATA = 4;
Package.TYPE_KICK = 5;
*/
//根据不同的返回值类型调用不同的函数
var processPackage = function(msg){
	handlers[msg.type](msg.body);
};
var processMessageBatch = function(pomelo, msgs) {
	for(var i=0, l=msgs.length; i<l; i++) {
		processMessage(pomelo, msgs[i]);
	}
};
var handshakeInit = function(data){
	if(data.sys && data.sys.heartbeat) {
		heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
		heartbeatTimeout = heartbeatInterval * 2;        // max heartbeat timeout
	} else {
		heartbeatInterval = 0;
		heartbeatTimeout = 0;
	}

	initData(data);
	
	//调用init的回调函数
	if(typeof handshakeCallback === 'function') {
		handshakeCallback(data.user);
	}
};

//根据服务端返回的信息初始化客户端的一些内容
var initData = function(data) {
	if(!data || !data.sys) {
		return;
	}
	pomelo.data = pomelo.data || {};
	var dict = data.sys.dict;
	var protos = data.sys.protos;

	//Init compress dict
	if(!!dict){
		pomelo.data.dict = dict;
		pomelo.data.abbrs = {};

		for(var route in dict){
			pomelo.data.abbrs[dict[route]] = route;
		}
	}

	//Init protobuf protos
	if(!!protos){
		pomelo.data.protos = {
			server : protos.server || {},
			client : protos.client || {}
		};
		if(!!protobuf){
			protobuf.init({encoderProtos: protos.client, decoderProtos: protos.server});
		}
	}
};
