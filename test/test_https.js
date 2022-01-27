'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const electrodeServer = require('electrode-server');
const needle = require('needle');
const { expect } = require('chai');
const fs = require('fs');
const Path = require('path');

describe('https routing', function() {
  const keyFile = Path.join(__dirname, '../samples/certs/dev-key.pem');
  const certFile = Path.join(__dirname, '../samples/certs/dev-cert.pem');

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

  const testFile = async (baseUrl, protocol = 'http') => {
    let proxy;
    const port = protocol === 'http' ? 18999 : 18943;

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
      },

      async () => {
        const dir = Path.join(__dirname, '../samples');
        proxy.register({
          src: `localhost${baseUrl}`,
          target: `file://${dir}`
        });

        proxy.register({
          src: `localhost${baseUrl}/blah`,
          target: `file://${Path.join(dir, 'sample1.js')}`,
          headers: {
            blah: 'test-1'
          }
        });

        const r403 = await needle('get', `${protocol}://localhost:${port}${baseUrl}`, {
          rejectUnauthorized: false
        });
        expect(r403.statusCode).to.equal(403);

        const rSample1 = await needle(
          'get',
          `${protocol}://localhost:${port}${baseUrl}/sample1.js`,
          {
            rejectUnauthorized: false
          }
        );
        const sample1 = await fs.promises.readFile(Path.join(dir, 'sample1.js'));
        expect(rSample1.body.toString()).to.equal(sample1.toString());
        expect(rSample1.headers['content-type']).to.equal('application/javascript');

        const rCert = await needle(
          'get',
          `${protocol}://localhost:${port}${baseUrl}/certs/dev-cert.pem`,
          {
            rejectUnauthorized: false
          }
        );
        const cert = await fs.promises.readFile(Path.join(dir, 'certs/dev-cert.pem'));
        expect(rCert.body.toString()).to.equal(cert.toString());
        expect(rCert.headers['content-type']).to.equal('application/x-x509-ca-cert');

        const r404 = await needle('get', `${protocol}://localhost:${port}${baseUrl}/not-found.js`, {
          rejectUnauthorized: false
        });
        expect(r404.statusCode).to.equal(404);

        const rBr = await needle('get', `${protocol}://localhost:${port}${baseUrl}/sample1.js`, {
          headers: { 'accept-encoding': 'gzip, deflate, br' },
          rejectUnauthorized: false
        });
        const brSample1 = await fs.promises.readFile(Path.join(dir, 'sample1.js.br'));
        expect(rBr.headers['content-encoding']).to.equal('br');
        expect(rBr.raw).to.deep.equal(brSample1);

        const rGz = await needle('get', `${protocol}://localhost:${port}${baseUrl}/sample1.js`, {
          headers: { 'accept-encoding': 'gzip, deflate' },
          rejectUnauthorized: false
        });
        const gzSample1 = await fs.promises.readFile(Path.join(dir, 'sample1.js.gz'));
        expect(rGz.headers['content-encoding']).to.equal('gzip');
        expect(rGz.raw).to.deep.equal(gzSample1);

        const sample1Gz = await needle('get', `${protocol}://localhost:${port}${baseUrl}/blah`, {
          headers: { 'accept-encoding': 'gzip, deflate' },
          rejectUnauthorized: false
        });
        expect(sample1Gz.headers['content-encoding']).to.equal('gzip');
        expect(sample1Gz.headers.blah).to.equal('test-1');
        expect(sample1Gz.raw).to.deep.equal(gzSample1);
      },
      runFinally(() => proxy && proxy.close())
    );
  };

  it('should respond data from file targets', async () => {
    await testFile('', 'http');
    await testFile('', 'https');
  });

  it('should respond data from file targets with base url', async () => {
    await testFile('/test/blah', 'http');
    await testFile('/test/blah', 'https');
  });
});
