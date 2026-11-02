'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  net = require('node:net'),
  { listenLocal, parseForwards } = require('../src/remote');

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
