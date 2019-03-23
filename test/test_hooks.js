'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const electrodeServer = require('electrode-server');
const needle = require('needle');
const { expect } = require('chai');

describe('hooks', function() {
  function setupTestRoute(handler) {
    return electrodeServer().then(server => {
      server.route({
        method: 'get',
        path: '/test',
        handler
      });
      return server;
    });
  }

  it('onRequest should be able to modify headers for a route', () => {
    let server;
    let proxy;
    let serverReq;
    let proxyReq;
    let saveProxyHeaders;
    let target;

    return asyncVerify(
      () => {
        return setupTestRoute(req => {
          serverReq = req;
          return 'hello test';
        });
      },
      s => {
        server = s;
        proxy = redbird({ bunyan: false, port: 18999 });
        proxy.register({
          src: 'localhost/x',
          target: 'http://localhost:3000/test',
          onRequest: (req, res, tgt) => {
            proxyReq = req;
            saveProxyHeaders = Object.assign({}, req.headers);
            req.headers.foo = 'bar';
            delete req.headers.blah;
            target = tgt;
          }
        });

        return needle('get', 'http://localhost:18999/x', {
          headers: {
            blah: 'xyz'
          }
        });
      },
      res => {
        expect(res.statusCode).to.equal(200);
        expect(target).to.exist;
        expect(saveProxyHeaders).to.exist;
        expect(saveProxyHeaders.blah).to.equal('xyz');
        expect(serverReq).to.exist;
        expect(serverReq.headers.foo).to.equal('bar');
        expect(serverReq.headers.blah).to.equal(undefined);
      },
      runFinally(() => proxy && proxy.close()),
      runFinally(() => server && server.stop())
    );
  });

  it('onRequest should be able skip forwarding by returning false target', () => {
    let server;
    let proxy;
    let serverReq;
    let proxyReq;
    let saveProxyHeaders;
    let target;
    let responseTarget;

    return asyncVerify(
      () => {
        return setupTestRoute(req => {
          serverReq = req;
          return 'hello test';
        });
      },
      s => {
        server = s;
        proxy = redbird({ bunyan: false, port: 18999 });
        proxy.register({
          src: 'localhost/x',
          target: 'http://localhost:3000/test',
          onRequest: (req, res, tgt) => {
            proxyReq = req;
            saveProxyHeaders = req.headers;
            target = tgt;
            res.statusCode = 500;
            res.write('skip forward');
            res.end();
            return false;
          },
          onResponse: (req, res, tgt) => {
            responseTarget = tgt;
          }
        });
        return needle('get', 'http://localhost:18999/x', {
          headers: {
            blah: 'xyz'
          }
        });
      },
      res => {
        expect(res.statusCode).to.equal(500);
        expect(target).to.exist;
        expect(saveProxyHeaders).to.exist;
        expect(saveProxyHeaders.blah).to.equal('xyz');
        expect(serverReq).to.not.exist;
        expect(responseTarget).to.equal(false);
      },
      runFinally(() => proxy && proxy.close()),
      runFinally(() => server && server.stop())
    );
  });

  it('onError should be invoked for proxy errors', () => {
    let proxy;
    let proxyReq;
    let proxyError;
    let saveProxyHeaders;
    let target;

    return asyncVerify(
      () => {
        proxy = redbird({ bunyan: false, port: 18999 });
        proxy.register({
          src: 'localhost/x',
          target: 'http://localhost:3000/test',
          onRequest: (req, res, tgt) => {
            proxyReq = req;
            saveProxyHeaders = req.headers;
            target = tgt;
          },
          onResponse: (req, res, tgt) => {
            responseTarget = tgt;
          },
          onError: (err, req, res) => {
            proxyError = err;
            proxy.handleProxyError(err, req, res);
          }
        });
        return needle('get', 'http://localhost:18999/x', {
          headers: {
            blah: 'xyz'
          }
        });
      },
      res => {
        expect(res.statusCode).to.equal(502);
        expect(target).to.exist;
        expect(saveProxyHeaders).to.exist;
        expect(saveProxyHeaders.blah).to.equal('xyz');
        expect(proxyError).to.exist;
        expect(proxyError.code).to.equal('ECONNREFUSED');
      },
      runFinally(() => proxy && proxy.close())
    );
  });
});
