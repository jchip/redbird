'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const electrodeServer = require('electrode-server');
const needle = require('needle');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('https routing', function() {
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

  it('should forward from http/https to https', () => {
    let server;
    let proxy;

    return asyncVerify(
      () => {
        return setupTestRoute(req => `hello test`);
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
          httpProxy: {
            secure: false
          }
        });

        return needle('get', 'http://localhost:18999/x');
      },
      res => {
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.equal('hello test');
        return needle('get', 'https://localhost:18943/x', { rejectUnauthorized: false });
      },
      res => {
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.equal('hello test');
      },
      runFinally(() => proxy && proxy.close()),
      runFinally(() => server && server.stop())
    );
  });
});
