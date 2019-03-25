'use strict';

const es = require('electrode-server');
const redbird = require('..');
const path = require('path');
const fs = require('fs');

async function sample1() {
  const keyFile = path.join(__dirname, 'certs/dev-key.pem');
  const certFile = path.join(__dirname, 'certs/dev-cert.pem');
  const server = await es({
    connection: { port: 8443 },
    server: {
      tls: {
        key: fs.readFileSync(keyFile, 'utf8'),
        cert: fs.readFileSync(certFile, 'utf8')
      }
    }
  });

  const proxy = redbird({
    port: 8080,
    ssl: {
      port: 8043,
      key: keyFile,
      cert: certFile
    }
  });

  server.route({
    method: 'get',
    path: '/test',
    handler: (req, h) => {
      return 'hello world';
    }
  });

  proxy.register({
    src: 'localhost/x',
    target: 'https://localhost:8443/test',
    onRequest: (req, res, target) => {},
    httpProxy: {
      // avoid self signed cert error
      // note setting process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' doesn't work
      // because http-proxy creates an instance of the https request
      // that defaults rejectUnauthorized to true.
      secure: false
    }
  });
}

sample1();
