'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  net = require('node:net'),
  { listenLocal, parseForwards, parseRtts } = require('../src/remote');

test('connect parses repeatable named Client ports and rejects ambiguous or invalid services', () => {
  assert.deepEqual(parseForwards(['Web UI=3000', 'MQTT=1883']), [
    { name: 'Web UI', port: 3000 },
    { name: 'MQTT', port: 1883 }
  ]);
  for (const value of ['=3000', 'Web UI=0', 'Web UI=65536', 'bad/name=3000', 'Web UI=port']){
    assert.throws(() => parseForwards([value]), /--forward/);
  }
  assert.throws(() => parseForwards(['Web UI=3000', 'web ui=8080']), /repeated/);
});

test('connect parses a repeated RTT config with a validated memory range', () => {
  assert.deepEqual(parseRtts(['1=0x20000000,0x10000', '2=536870912,65536,1']), [
    { index: 1, address: '0x20000000', size: '0x10000', channel: 0 },
    { index: 2, address: '536870912', size: '65536', channel: 1 }
  ]);
  for (const value of ['1=0x20000000', '0=0x20000000,0x10000', '1=0x20000000,0,0', '1=0x20000000,0x10000,256',
    '1=0x20000000;shutdown,0x10000']){
    assert.throws(() => parseRtts([value]), /--rtt/);
  }
  assert.throws(() => parseRtts(['1=0x20000000,0x10000', '1=0x20000000,0x10000']), /repeated/);
});

test('a named service listener bridges TCP data to and from the Client channel', async (t) => {
  let resolveChannel;
  const channelReady = new Promise((resolve) => {
      resolveChannel = resolve;
    }),
    destination = net.createServer(),
    destinationPort = await new Promise((resolve, reject) => {
      destination.once('error', reject);
      destination.listen(0, '127.0.0.1', () => resolve(destination.address().port));
    }),
    session = {
      open(kind, index, current, options){
        assert.equal(kind, 'service');
        assert.equal(index, 1);
        assert.deepEqual(options.extra, { name: 'Web UI', port: destinationPort });
        resolveChannel(current);
        return 7;
      },
      write(ch, data){
        assert.equal(ch, 7);
        assert.equal(data.toString(), 'request');
      },
      close(){}
    },
    local = await listenLocal(session,
      { uarts: [], probes: [] },
      { host: '127.0.0.1', forwards: [{ name: 'Web UI', port: destinationPort }], log(){} }),
    client = net.connect(local.forwards[0].port, '127.0.0.1');
  t.after(() => {
    client.destroy();
    local.servers.forEach((server) => server.close());
    destination.close();
  });

  test('an RTT listener opens a read-only RTT channel and exposes a local port', async (t) => {
    let resolveChannel;
    const channelReady = new Promise((resolve) => {
        resolveChannel = resolve;
      }),
      session = {
        open(kind, index, current, options){
          assert.equal(kind, 'rtt');
          assert.equal(index, 1);
          assert.deepEqual(options.extra, { address: '0x20000000', size: '0x10000', channel: 0 });
          resolveChannel(current);
          return 9;
        },
        write(){
          assert.fail('RTT listener must not send input to the Client');
        },
        close(){}
      },
      local = await listenLocal(session, { uarts: [], probes: [] }, {
        host: '127.0.0.1', rtts: [{ index: 1, address: '0x20000000', size: '0x10000', channel: 0 }], log(){}
      }),
      client = net.connect(local.ports[0].port, '127.0.0.1');
    t.after(() => {
      client.destroy();
      local.servers.forEach((server) => server.close());
    });
    assert.equal(local.ports[0].kind, 'rtt');
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const currentHandler = await channelReady;
    currentHandler.data(Buffer.from('RTT log'));
    const output = await new Promise((resolve, reject) => {
      client.once('data', (data) => resolve(data.toString()));
      client.once('error', reject);
    });
    assert.equal(output, 'RTT log');
    client.write('ignored');
    await new Promise((resolve) => setImmediate(resolve));
  });
  const service = local.forwards[0];
  assert.equal(service.name, 'Web UI');
  assert.equal(service.clientPort, destinationPort);
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  const currentHandler = await channelReady;
  client.write('request');
  await new Promise((resolve) => setImmediate(resolve));
  const responsePromise = new Promise((resolve, reject) => {
    client.once('data', (data) => resolve(data.toString()));
    client.once('error', reject);
  });
  currentHandler.data(Buffer.from('response'));
  const response = await responsePromise;
  assert.equal(response, 'response');
});
