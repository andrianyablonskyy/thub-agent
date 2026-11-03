/**
 * @file        packages/agent/src/remote.js
 * @description Remote board access (README §5.6): the Agent's WebSocket session to a reserved runner, reconnecting
 *              by itself, and the local TCP ports (`thub connect`) and terminal (`thub console`) on top of it
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

const net = require('node:net'),
  http = require('node:http'),
  dgram = require('node:dgram'),
  { EventEmitter } = require('node:events'),
  {
    decodeData, dataMessages, parseControl, backoffMs, REMOTE_CLOSE, SERVICE_NAME_RE, OPENOCD_TARGET_RE, validRttConfig
  } = require('@andrian.yablonskyy/thub-common');

// Without a ping from the Coordinator (every 30 s) for this long, the
// connection is taken for dead and made again.
const PING_TIMEOUT_MS = 75_000,
  // HTTP answers to the upgrade that won't change by trying again: a
  // refusal, or — a redirect, 426 — a reverse proxy that doesn't pass
  // WebSocket upgrades on to the Coordinator.
  FINAL_STATUSES = new Set([401, 403, 404, 409, 426]),
  isFinal = (status) => FINAL_STATUSES.has(status) || (status >= 300 && status < 400),
  PROXY_HINT = 'a reverse proxy in front of the Coordinator isn\'t passing WebSocket upgrades on to it ' +
    '(Help → Reserved boards → Client host setup)';

// One WebSocket to the reservation's own link (/api/v1/remote/<reservation>,
// from GET /resources), made again whenever it drops (1 s, 2 s, 4 s … 30 s
// apart) until that reservation ends or stop(). Channels are opened with open(); a `persistent` one (a UART or
// video stream) is opened again on its own once the Client is back, while a
// GDB or service connection is closed.
//
// Events: status ({ state, client, until }), devices ({ uarts, probes }),
// disconnected ({ retryMs, reason }), connected, fatal (message).
class RemoteSession extends EventEmitter{
  constructor({ url, token, client, userAgent, WebSocket = require('ws') }){
    super();
    Object.assign(this, { url, token, client, userAgent, WebSocket });
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.attempt = 0;
    this.everConnected = false;
    this.channels = new Map(); // ch -> { kind, index, extra, persistent, handler, open, queue }
    this.nextCh = 1;
    this.devices = null;
  }

  start(){
    this.stopped = false;
    this._connect();
    return this;
  }

  stop(){
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pingTimer);
    for (const ch of [...this.channels.keys()]){
      this.close(ch);
    }
    this.ws?.close(1000, 'bye');
  }

  _connect(){
    if (this.stopped){
      return;
    }
    const ws = new this.WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}`, ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}) },
      handshakeTimeout: 15_000
    });
    this.ws = ws;
    let refused = null;
    const alive = () => {
      clearTimeout(this.pingTimer);
      this.pingTimer = setTimeout(() => ws.terminate(), PING_TIMEOUT_MS);
      this.pingTimer.unref?.();
    };
    ws.on('open', () => {
      this.attempt = 0;
      alive();
      this.emit('connected', { again: this.everConnected });
      this.everConnected = true;
    });
    ws.on('ping', alive);
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        let error;
        try {
          error = JSON.parse(body).error;
        }
        catch {
          error = null;
        }
        const status = res.statusCode,
          location = res.headers.location ? ` → ${res.headers.location}` : '';
        refused = {
          status,
          error: error || (status >= 300 && status < 400
            ? `The Coordinator answered HTTP ${status}${location} instead of opening a WebSocket: ${PROXY_HINT}`
            : `HTTP ${status}`)
        };
        ws.terminate();
      });
    });
    ws.on('message', (data, isBinary) => (isBinary ? this._onData(data) : this._onControl(parseControl(data))));
    ws.on('error', () => {}); // 'close' follows, and says what to do
    ws.on('close', (code, reasonBuf) => {
      clearTimeout(this.pingTimer);
      if (this.ws !== ws){
        return;
      }
      this.ws = null;
      this._remoteGone('the connection dropped');
      const reason = String(reasonBuf || '') || refused?.error || null;
      if (this.stopped){
        return;
      }
      if ((refused && isFinal(refused.status)) || code === REMOTE_CLOSE.RESERVATION_ENDED || code === REMOTE_CLOSE.REPLACED){
        this.stopped = true;
        const message = reason || 'The Coordinator ended the connection';
        for (const ch of [...this.channels.keys()]){
          this._finish(ch, message);
        }
        return this.emit('fatal', message);
      }
      const retryMs = backoffMs(this.attempt++);
      this.emit('disconnected', { retryMs, reason });
      this.retryTimer = setTimeout(() => this._connect(), retryMs);
    });
  }

  // Everything open on the Client side is gone (link or connection down).
  _remoteGone(reason){
    this.ready = false;
    for (const [ch, c]of [...this.channels]){
      c.open = false;
      if (!c.persistent){
        this._finish(ch, reason);
      }
    }
  }

  _onControl(msg){
    if (!msg){
      return;
    }
    if (msg.t === 'status'){
      this.emit('status', msg);
      if (msg.state === 'waiting'){
        this._remoteGone(`${msg.client || 'the runner'}'s Client went away`);
      }
      return;
    }
    if (msg.t === 'devices'){
      this.devices = { uarts: msg.uarts || [], probes: msg.probes || [], serial: msg.serial !== false, camera: msg.camera || null };
      this.emit('devices', this.devices);
      // Ready again: every channel still wanted is opened on the Client.
      this.ready = true;
      for (const [ch, c]of this.channels){
        if (!c.open){
          this._sendOpen(ch, c);
        }
      }
      return;
    }
    const c = this.channels.get(msg.ch);
    if (!c){
      return;
    }
    if (msg.t === 'opened'){
      c.open = true;
      c.handler.opened?.(msg);
      for (const data of c.queue.splice(0)){
        this._sendData(msg.ch, data);
      }
    }
    else if (msg.t === 'note'){
      c.handler.note?.(String(msg.text || ''));
    }
    else if (msg.t === 'close'){
      this._finish(msg.ch, msg.reason || 'closed by the Client');
    }
  }

  _onData(buf){
    const frame = decodeData(buf);
    frame && this.channels.get(frame.ch)?.handler.data?.(frame.data);
  }

  _sendJson(msg){
    if (this.ws?.readyState === this.WebSocket.OPEN){
      this.ws.send(JSON.stringify(msg));
    }
  }

  _sendData(ch, data){
    if (this.ws?.readyState === this.WebSocket.OPEN){
      for (const msg of dataMessages(ch, data)){
        this.ws.send(msg, { binary: true });
      }
    }
  }

  _sendOpen(ch, c){
    this._sendJson({ t: 'open', ch, kind: c.kind, index: c.index, ...c.extra });
  }

  // A new channel to UART/probe `index`. `handler`: { opened(msg), data(buf),
  // note(text), closed(reason) }. Returns its id.
  open(kind, index, handler, { persistent = false, extra = {} } = {}){
    let ch = this.nextCh;
    while (this.channels.has(ch)){
      ch = ch >= 0xffff ? 1 : ch + 1;
    }
    this.nextCh = ch >= 0xffff ? 1 : ch + 1;
    const c = { kind, index, extra, persistent, handler, open: false, queue: [] };
    this.channels.set(ch, c);
    if (this.ready){
      this._sendOpen(ch, c);
    }
    return ch;
  }

  // Bytes for the channel's device; queued (GDB's first packets) until the
  // Client has it open, dropped while a UART waits for the Client to return.
  write(ch, data){
    const c = this.channels.get(ch);
    if (!c){
      return;
    }
    if (c.open){
      this._sendData(ch, data);
    }
    else if (!c.persistent){
      c.queue.push(data);
    }
  }

  close(ch){
    if (this.channels.has(ch)){
      this.channels.delete(ch);
      this._sendJson({ t: 'close', ch });
    }
  }

  _finish(ch, reason){
    const c = this.channels.get(ch);
    if (c){
      this.channels.delete(ch);
      c.handler.closed?.(reason);
    }
  }
}

// `thub connect`: local TCP ports for UARTs, ST-Links, RTT logs, and named services on
// the Client's loopback interface. Returns the servers.
function listenLocal(session, devices, { host, uartBase, gdbBase, target, forwards = [], rtts = [], fallbackPorts = {}, log }){
  const servers = [],
    bridge = (kind, index, opts) => (sock) => {
      sock.setNoDelay(true);
      let ch = null;
      const end = () => {
        if (ch !== null){
          session.close(ch);
          ch = null;
        }
      };
      ch = session.open(kind, index, {
        data: (buf) => sock.write(buf),
        note: (text) => log(kind === 'service' ? `${opts.name}: ${text}` : `${kind === 'uart' ? 'UART' : kind === 'rtt' ? 'RTT' : 'SWD'} ${index}: ${text}`),
        closed: (reason) => {
          ch = null;
          log(kind === 'service' ? `${opts.name}: ${reason}` : `${kind === 'uart' ? 'UART' : kind === 'rtt' ? 'RTT' : 'SWD'} ${index}: ${reason}`);
          sock.destroy();
        }
      }, opts);
      sock.on('data', (buf) => ch !== null && !opts.readOnly && session.write(ch, buf));
      sock.on('close', end);
      sock.on('error', end);
    },
    listenAt = (port, onConn) => new Promise((resolve, reject) => {
      const srv = net.createServer(onConn);
      srv.once('error', (err) => {
        err.port ??= port;
        reject(err);
      });
      srv.listen(port, host, () => {
        servers.push(srv);
        resolve(srv.address().port);
      });
    }),
    listen = async (port, onConn, fallbackLabel) => {
      try {
        return await listenAt(port, onConn);
      }
      catch (err){
        if (err.code !== 'EADDRINUSE' || !fallbackLabel){
          throw err;
        }
        const availablePort = await listenAt(0, onConn);
        log(`Default local ${fallbackLabel} port ${port} is in use; using ${availablePort} instead.`);
        return availablePort;
      }
    },
    pending = [
      ...devices.uarts.map(async (u) => ({
        kind: 'uart', device: u,
        port: await listen(uartBase ? uartBase + u.index - 1 : 0, bridge('uart', u.index, { persistent: true }),
          fallbackPorts.uart ? 'UART' : null)
      })),
      ...devices.probes.map(async (p) => ({
        kind: 'swd', device: p,
        port: await listen(gdbBase ? gdbBase + p.index - 1 : 0, bridge('swd', p.index, { extra: target ? { target } : {} }),
          fallbackPorts.gdb ? 'GDB' : null)
      })),
      ...rtts.map(async (rtt) => ({
        kind: 'rtt',
        device: { index: rtt.index, label: `RTT channel ${rtt.channel}` },
        port: await listen(0, bridge('rtt', rtt.index, {
          readOnly: true,
          extra: {
            address: rtt.address, size: rtt.size, channel: rtt.channel,
            ...(rtt.target || target ? { target: rtt.target || target } : {})
          }
        }))
      })),
      ...forwards.map(async ({ name, port: clientPort }) => ({
        name, clientPort,
        port: await listen(0, bridge('service', 1, { extra: { name, port: clientPort }, name }))
      }))
    ];
  return Promise.allSettled(pending).then((results) => {
    const failure = results.find((result) => result.status === 'rejected');
    if (failure){
      servers.forEach((srv) => srv.close());
      throw failure.reason;
    }
    const opened = results.map((result) => result.value);
    return {
      servers,
      ports: opened.filter((r) => r.kind),
      forwards: opened.filter((r) => r.name)
    };
  });
}

// `thub connect`: the board's USB camera (README §5.7) — H.264 in MPEG-TS,
// streamed by the Client since the reservation started — on a local URL
// that's this reservation's own: http://<host>:<port>/<reservation>/video.ts
// (VLC, ffplay, mpv). Each viewer is a channel of its own. With `udpPort`,
// also re-sent as UDP datagrams to udp://<host>:<udpPort> (QGroundControl,
// GStreamer). Resolves to { server, url, udp, close() }.
function serveVideo(session, { host, port, reservation, udpPort = null, fallbackPort = false, log }){
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host,
    videoPath = `/${reservation}/video.ts`,
    server = http.createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== videoPath){
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not this reservation\'s video — thub connect prints its current link.\n');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      let ch = session.open('video', 1, {
        data: (buf) => res.write(buf),
        note: (text) => log(`Video: ${text}`),
        closed: (reason) => {
          ch = null;
          log(`Video: ${reason}`);
          res.end();
        }
      }, { persistent: true });
      req.on('close', () => ch !== null && session.close(ch));
    });
  let udp = null,
    udpCh = null;
  if (udpPort){
    udp = dgram.createSocket(target.includes(':') ? 'udp6' : 'udp4');
    udp.on('error', (err) => log(`Video (UDP): ${err.message}`));
    udpCh = session.open('video', 1, {
      data: (buf) => udp.send(buf, udpPort, target),
      note: (text) => log(`Video: ${text}`),
      closed: (reason) => log(`Video (UDP): ${reason}`)
    }, { persistent: true });
  }
  return new Promise((resolve, reject) => {
    const finish = (actualPort) => resolve({
        server,
        url: `http://${target.includes(':') ? `[${target}]` : target}:${actualPort}${videoPath}`,
        udp: udpPort ? `udp://${target}:${udpPort}` : null,
        close: () => {
          server.close();
          server.closeAllConnections?.();
          if (udpCh !== null){
            session.close(udpCh);
          }
          udp?.close();
        }
      }),
      onError = (err) => {
        err.port ??= port;
        if (err.code !== 'EADDRINUSE' || !fallbackPort){
          return reject(err);
        }
        server.removeListener('error', onError);
        server.once('error', reject);
        server.listen(0, host, () => {
          const availablePort = server.address().port;
          log(`Default local video port ${port} is in use; using ${availablePort} instead.`);
          finish(availablePort);
        });
      };
    server.once('error', onError);
    server.listen(port, host, () => finish(server.address().port));
  });
}

function parseForwards(values){
  const seen = new Set();
  return values.map((value) => {
    const split = value.lastIndexOf('='),
      name = value.slice(0, split).trim(),
      portText = value.slice(split + 1),
      port = Number(portText);
    if (split < 1 || !SERVICE_NAME_RE.test(name) || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535){
      throw new Error(`--forward ${value}: use a service name and Client port, e.g. --forward "Web UI=3000"`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)){
      throw new Error(`--forward: service name "${name}" is repeated`);
    }
    seen.add(key);
    return { name, port };
  });
}

function parseRtts(values){
  const seen = new Set();
  return values.map((value) => {
    const split = value.indexOf('='),
      index = Number(value.slice(0, split)),
      fields = value.slice(split + 1).split(','),
      [address, size, channelText, target] = fields,
      channel = channelText === undefined ? 0 : Number(channelText);
    if (split < 1 || !/^\d+$/.test(value.slice(0, split)) || !Number.isInteger(index) || index < 1 || index > 64 ||
        fields.length < 2 || fields.length > 4 || (channelText !== undefined && !/^\d+$/.test(channelText)) ||
        (target !== undefined && !OPENOCD_TARGET_RE.test(target)) ||
        !validRttConfig({ address, size, channel })){
      throw new Error(`--rtt ${value}: use probe index, RAM address, search size, optional channel and target, ` +
        'e.g. --rtt 1=0x20000000,0x10000,0,stm32g4x');
    }
    if (seen.has(index)){
      throw new Error(`--rtt: ST-Link ${index} is repeated`);
    }
    seen.add(index);
    return { index, address, size, channel, ...(target ? { target } : {}) };
  });
}

module.exports = { RemoteSession, listenLocal, serveVideo, parseForwards, parseRtts };
