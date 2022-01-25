'use strict';

var Redbird = require('../');
var http = require('http');
var expect = require('chai').expect;

var TEST_PORT = 54674;
var PROXY_PORT = 53433;

var opts = {
  port: PROXY_PORT,
  bunyan: false
};

function httpGet(url) {
  return new Promise(resolve => {
    http
      .get(url, res => {
        res.data = '';
        res.on('data', chunk => (res.data += chunk));
        res.on('end', () => resolve(res));
      })
      .end();
  });
}

describe('Target with a hostname', function() {
  it('Should have the host header passed to the target', function() {
    var redbird = Redbird(opts);

    expect(redbird.routing).to.be.an('object');

    redbird.register('127.0.0.1', '127.0.0.1.nip.io:' + TEST_PORT, {
      useTargetHostHeader: true
    });

    expect(redbird.routing).to.have.property('127.0.0.1');

    return Promise.all([
      testServer().then(function(req) {
        expect(req.headers['host']).to.be.eql('127.0.0.1.nip.io:' + TEST_PORT);
      }),
      httpGet('http://127.0.0.1:' + PROXY_PORT)
    ]).then(() => redbird.close());
  });

  it('Should not have the host header passed to the target', function() {
    var redbird = Redbird(opts);

    expect(redbird.routing).to.be.an('object');

    redbird.register('127.0.0.1', '127.0.0.1.nip.io:' + TEST_PORT);

    expect(redbird.routing).to.have.property('127.0.0.1');

    return Promise.all([
      testServer().then(function(req) {
        expect(req.headers['host']).to.be.eql('127.0.0.1:' + PROXY_PORT);
      }),

      httpGet('http://127.0.0.1:' + PROXY_PORT)
    ]).then(() => redbird.close());
  });

  it('Should return 404 after route is unregister', function() {
    var redbird = Redbird(opts);

    expect(redbird.routing).to.be.an('object');

    redbird.register('127.0.0.1', '127.0.0.1.nip.io:' + TEST_PORT);
    redbird.unregister('127.0.0.1', '127.0.0.1.nip.io:' + TEST_PORT);

    expect(redbird.routing).to.have.property('127.0.0.1');

    return httpGet('http://127.0.0.1:' + PROXY_PORT).then(res => {
      expect(res.statusCode).to.be.eql(404);
      return redbird.close();
    });
  });

  it('Should return 502 after route with no backend', function() {
    var redbird = Redbird(opts);

    expect(redbird.routing).to.be.an('object');

    redbird.register('127.0.0.1', '127.0.0.1.nip.io:502');

    expect(redbird.routing).to.have.property('127.0.0.1');

    return httpGet('http://127.0.0.1:' + PROXY_PORT).then(res => {
      expect(res.statusCode).to.be.eql(502);

      return redbird.close();
    });
  });
});

describe('Request with forwarded host header', function() {
  it('should prefer forwarded hostname if desired', function() {
    var redbird = Redbird({
      bunyan: false,
      preferForwardedHost: true
    });

    expect(redbird.routing).to.be.an('object');
    var req = {
      headers: {
        host: '127.0.0.1',
        'x-forwarded-host': 'subdomain.example.com'
      }
    };

    var source = redbird._getSource(req);
    expect(source).to.be.eql('subdomain.example.com');

    redbird.close();
  });

  it('should use original host if not further specified', function() {
    var redbird = Redbird(opts);

    expect(redbird.routing).to.be.an('object');
    var req = {
      headers: {
        host: '127.0.0.1',
        'x-forwarded-host': 'subdomain.example.com'
      }
    };

    var source = redbird._getSource(req);
    expect(source).to.be.eql('127.0.0.1');

    redbird.close();
  });
});

function testServer() {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      res.write('test-server:' + req.headers.host);
      res.end();
      server.close(() => resolve(req));
    });

    server.listen(TEST_PORT);
  });
}
