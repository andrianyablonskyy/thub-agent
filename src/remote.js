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
  { EventEmitter } = require('node:events'),
  { decodeData, dataMessages, parseControl, backoffMs, REMOTE_CLOSE } = require('@andrian.yablonskyy/thub-common');

// Without a ping from the Coordinator (every 30 s) for this long, the
// connection is taken for dead and made again.
const PING_TIMEOUT_MS = 75_000,
  // HTTP answers to the upgrade that won't change by trying again.
  FINAL_STATUSES = new Set([401, 403, 404, 409]);

// One WebSocket to the reservation's own link (/api/v1/remote/<reservation>,
// from GET /resources), made again whenever it drops (1 s, 2 s, 4 s … 30 s
// apart) until that reservation ends or stop(). Channels are opened with open(); a `persistent` one (a UART) is
// opened again on its own once the Client is back, a GDB one is closed —
// a debugger's state doesn't survive a dropped connection anyway.
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
        refused = { status: res.statusCode, error: error || `HTTP ${res.statusCode}` };
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
      if ((refused && FINAL_STATUSES.has(refused.status)) || code === REMOTE_CLOSE.RESERVATION_ENDED || code === REMOTE_CLOSE.REPLACED){
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
      this.devices = { uarts: msg.uarts || [], probes: msg.probes || [], serial: msg.serial !== false };
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

// `thub connect`: a local TCP port per UART (every connection to it sees the
// board's output and types to it) and per ST-Link (a GDB server: each
// connection gets its own OpenOCD on the Client). Returns the servers.
function listenLocal(session, devices, { host, uartBase, gdbBase, target, log }){
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
        note: (text) => log(`${kind === 'uart' ? 'UART' : 'SWD'} ${index}: ${text}`),
        closed: (reason) => {
          ch = null;
          log(`${kind === 'uart' ? 'UART' : 'SWD'} ${index}: ${reason}`);
          sock.destroy();
        }
      }, opts);
      sock.on('data', (buf) => ch !== null && session.write(ch, buf));
      sock.on('close', end);
      sock.on('error', end);
    },
    listen = (port, onConn) => new Promise((resolve, reject) => {
      const srv = net.createServer(onConn);
      srv.once('error', reject);
      srv.listen(port, host, () => {
        servers.push(srv);
        resolve(srv.address().port);
      });
    });
  return Promise.all([
    ...devices.uarts.map(async (u) => ({
      kind: 'uart', device: u, port: await listen(uartBase ? uartBase + u.index - 1 : 0, bridge('uart', u.index, { persistent: true }))
    })),
    ...devices.probes.map(async (p) => ({
      kind: 'swd', device: p,
      port: await listen(gdbBase ? gdbBase + p.index - 1 : 0, bridge('swd', p.index, { extra: target ? { target } : {} }))
    }))
  ]).then((ports) => ({ servers, ports }));
}

module.exports = { RemoteSession, listenLocal };
