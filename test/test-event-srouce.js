'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const electrodeServer = require('electrode-server');
const needle = require('needle');
const { expect } = require('chai');
const http = require('http');
const https = require('https');
const EventSource = require('eventsource');
const fs = require('fs');
const path = require('path');

describe('event source', function() {
  const keyFile = path.join(__dirname, '../samples/certs/dev-key.pem');
  const certFile = path.join(__dirname, '../samples/certs/dev-cert.pem');

  const createEventSourceServer = (handler, _http, options) => {
    return (_http || http)
      .createServer(options || {}, (req, res) => {
        if (req.url == '/events') {
          res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });

          res.write('connected\n\n');

          handler(req, res);
        }
      })
      .listen(18991, 'localhost');
  };

  it('should work with http to http forwarding', () => {
    let server;
    let proxy;
    let eventSrc;
    const messages = [];
    let eventReq;
    let eventRes;

    const handler = (req, res) => {
      eventReq = req;
      eventRes = res;
    };

    const handleMesage = event => {
      messages.push(event);
    };

    return asyncVerify(
      () => createEventSourceServer(handler),
      (s, next) => {
        server = s;
        proxy = redbird({ bunyan: false, port: 18999 });
        proxy.register('localhost/x', 'http://localhost:18991/events');
        eventSrc = new EventSource('http://localhost:18999/x');
        eventSrc.onmessage = handleMesage;
        eventSrc.onopen = () => next();
        eventSrc.onerror = next;
      },
      next => {
        eventRes.write('data: hello1\n\n');
        setTimeout(next, 10);
      },
      next => {
        eventRes.write('data: hello2\n\n');
        setTimeout(next, 10);
      },
      () => {
        expect(messages[0]).to.exist;
        expect(messages[0].data).to.equal('hello1');
        expect(messages[1]).to.exist;
        expect(messages[1].data).to.equal('hello2');
      },
      runFinally(() => proxy && proxy.close()),
      runFinally(() => server && server.close()),
      runFinally(() => eventSrc && eventSrc.close())
    );
  });

  it('should work with http or https to https forwarding', () => {
    let server;
    let proxy;
    let eventSrc;
    let messages = [];
    let eventReq;
    let eventRes;

    const handler = (req, res) => {
      eventReq = req;
      eventRes = res;
    };

    const handleMesage = event => {
      messages.push(event);
    };

    return asyncVerify(
      () =>
        createEventSourceServer(handler, https, {
          key: fs.readFileSync(keyFile, 'utf8'),
          cert: fs.readFileSync(certFile, 'utf8')
        }),
      (s, next) => {
        server = s;
        proxy = redbird({
          bunyan: false,
          port: 18999,
          ssl: {
            port: 18943,
            key: keyFile,
            cert: certFile
          }
        });
        proxy.register({
          src: 'localhost/x',
          target: 'https://localhost:18991/events',
          httpProxy: {
            secure: false
          }
        });
        eventSrc = new EventSource('http://localhost:18999/x');
        eventSrc.onmessage = handleMesage;
        eventSrc.onopen = () => next();
        eventSrc.onerror = next;
      },
      next => {
        eventRes.write('data: hello1\n\n');
        setTimeout(next, 10);
      },
      next => {
        eventRes.write('data: hello2\n\n');
        setTimeout(next, 10);
      },
      next => {
        expect(messages[0]).to.exist;
        expect(messages[0].data).to.equal('hello1');
        expect(messages[1]).to.exist;
        expect(messages[1].data).to.equal('hello2');
        eventSrc.close();
        eventSrc = null;
        messages = [];
        eventRes.write('data: hello2\n\n');
        setTimeout(next, 10);
      },
      next => {
        expect(messages).to.be.empty;
        eventSrc = new EventSource('https://localhost:18943/x', { rejectUnauthorized: false });
        eventSrc.onmessage = handleMesage;
        eventSrc.onopen = () => next();
        eventSrc.onerror = next;
      },
      next => {
        eventRes.write('data: hello3\n\n');
        setTimeout(next, 10);
      },
      next => {
        eventRes.write('data: hello4\n\n');
        setTimeout(next, 10);
      },
      () => {
        expect(messages[0]).to.exist;
        expect(messages[0].data).to.equal('hello3');
        expect(messages[1]).to.exist;
        expect(messages[1].data).to.equal('hello4');
      },
      runFinally(() => proxy && proxy.close()),
      runFinally(() => server && server.close()),
      runFinally(() => eventSrc && eventSrc.close())
    );
  });
});
