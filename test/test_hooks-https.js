'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const electrodeServer = require('electrode-server');
const needle = require('needle');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('hooks for https routing', function() {
  const keyFile = path.join(__dirname, '../samples/certs/dev-key.pem');
  const certFile = path.join(__dirname, '../samples/certs/dev-cert.pem');

  function setupTestRoute(handler) {
    return electrodeServer({
      connection: { port: 8443 },
      server: {
        tls: {
          key: fs.readFileSync(keyFile, 'utf8'),
          cert: fs.readFileSync(certFile, 'utf8')
        }
      }
    }).then(server => {
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
          target: 'https://localhost:8443/test',
          onRequest: (req, res, tgt) => {
            proxyReq = req;
            saveProxyHeaders = Object.assign({}, req.headers);
            req.headers.foo = 'bar';
            delete req.headers.blah;
            target = tgt;
          },
          httpProxy: {
            secure: false
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
          target: 'https://localhost:8443/test',
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
          },
          httpProxy: {
            secure: false
          }
        });
        return needle('get', 'http://localhost:18999/x', {
          headers: {
            blah: 'xyz'
          },
          rejectUnauthorized: false
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
          target: 'https://localhost:8443/test',
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
          },
          httpProxy: {
            secure: false
          }
        });
        return needle('get', 'https://localhost:18943/x', {
          headers: {
            blah: 'xyz'
          },
          rejectUnauthorized: false
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
