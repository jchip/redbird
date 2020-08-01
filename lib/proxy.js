/*eslint-env node */
'use strict';

const fs = require('fs'),
  http = require('http'),
  httpProxy = require('http-proxy'),
  validUrl = require('valid-url'),
  parseUrl = require('url').parse,
  path = require('path'),
  _ = require('lodash'),
  pino = require('pino'),
  cluster = require('cluster'),
  hash = require('object-hash'),
  LRUCache = require('lru-cache'),
  routeCache = LRUCache({ max: 5000 }),
  safe = require('safetimeout'),
  letsencrypt = require('./letsencrypt.js'),
  Promise = require('bluebird');

const assert = require('assert');
const nullLog = require('./null-log');

const ONE_DAY = 60 * 60 * 24 * 1000;
const ONE_MONTH = ONE_DAY * 30;

const FORWARDING = Symbol('redbird.req.forwarding');

function ReverseProxy(inOpts) {
  if (!(this instanceof ReverseProxy)) {
    return new ReverseProxy(inOpts);
  }

  const opts = { port: 8080, httpProxy: {}, ...inOpts };
  this.opts = opts;

  var logOpts = opts.bunyan === undefined ? opts.pino : opts.bunyan;
  if (logOpts !== false) {
    this.log = pino({ name: 'redbird', ...logOpts });
  } else {
    this.log = nullLog;
  }

  assert(
    !opts.cluster || (typeof opts.cluster === 'number' && opts.cluster <= 32),
    'cluster setting must be an integer less than 32'
  );

  if (opts.cluster && cluster.isMaster) {
    for (var i = 0; i < opts.cluster; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      // Fork if a worker dies.
      this.log.error({ code: code, signal: signal }, 'worker died un-expectedly... restarting it.');
      cluster.fork();
    });
  } else {
    this._connections = {};
    this._connId = 0;
    this.resolvers = [this._defaultResolver];

    if (opts.letsencrypt) {
      this.setupLetsencrypt(log, opts);
    }

    if (opts.resolvers) {
      this.addResolver(opts.resolvers);
    }

    //
    // Routing table.
    //
    this.routing = {};

    //
    // Maintain different proxies in case changeOrigin is needed
    //
    this._proxies = {};

    this.proxy = this._createProxy(opts);

    //
    // Plain HTTP Proxy if port is defined
    //
    this.servers = [];
    if (opts.port) {
      this.servers.push(this._createHttpServer(opts));
    }

    //
    // Optionally create an https proxy servers.
    //
    this.httpsServers = [];
    if (opts.ssl) {
      this.certs = {};
      [].concat(opts.ssl).forEach(sslOpts => {
        if (sslOpts.port) {
          this.httpsServers.push(this._createHttpsServer(sslOpts));
        }
      });
    }
  }
}

/**
 * Create the proxy server to listen on HTTP
 */
ReverseProxy.prototype._createHttpServer = function(opts) {
  var httpServerModule = opts.serverModule || http;

  const server = httpServerModule.createServer((req, res) => {
    let _target, _route;
    var src = this._getSource(req);

    this._getRouteTarget(src, req, res)
      .then(({ target, route }) => {
        if (!route) return respondNotFound(req, res);

        _target = target;
        _route = route;

        if (target === false) return null;

        if (shouldRedirectToHttps(this.certs, src, target, this)) {
          return redirectToHttps(req, res, target, opts.ssl, this.log);
        } else {
          const httpProxyOpts = Object.assign(
            { target, secure: true },
            this.opts.httpProxy,
            route.opts.httpProxy
          );

          route.proxy.web(req, res, httpProxyOpts);

          return this._createForwardDefer(route, req);
        }
      })
      .then(() => {
        if (_route && _route.opts.onResponse) {
          return _route.opts.onResponse(req, res, _target);
        }
      })
      .catch(err => {
        if (_route && _route.opts.onError) {
          return _route.opts.onError(err, req, res, _target);
        } else if (this.opts.errorHandler) {
          return this.opts.errorHandler(err, req, res, _target);
        }
        this.handleProxyError(err, req, res);
      });
  });

  //
  // Listen to the `upgrade` event and proxy the
  // WebSocket requests as well.
  //
  server.on('upgrade', (...args) => this._websocketsUpgrade(...args));

  server.on('error', err => {
    this.log.error(err, 'Server Error');
  });

  server.on('connection', conn => this._saveConnection(conn));

  server.listen(opts.port, opts.host);

  this.log.info('Started a Redbird reverse proxy server on port %s', opts.port);

  return server;
};

ReverseProxy.prototype._createHttpsServer = function(sslOpts) {
  var https;

  var ssl = {
    SNICallback: (hostname, cb) => {
      if (cb) {
        cb(null, this.certs[hostname]);
      } else {
        return this.certs[hostname];
      }
    },
    //
    // Default certs for clients that do not support SNI.
    //
    key: getCertData(sslOpts.key),
    cert: getCertData(sslOpts.cert)
  };

  if (sslOpts.ca) {
    ssl.ca = getCertData(sslOpts.ca, true);
  }

  if (sslOpts.opts) {
    ssl = _.defaults(ssl, sslOpts.opts);
  }

  if (sslOpts.http2) {
    https = sslOpts.serverModule || require('spdy');
    if (_.isObject(sslOpts.http2)) {
      sslOpts.spdy = sslOpts.http2;
    }
  } else {
    https = sslOpts.serverModule || require('https');
  }

  const httpsServer = https.createServer(ssl, (req, res) => {
    const src = this._getSource(req);

    let _route, _target;
    this._getRouteTarget(src, req, res)
      .then(({ route, target }) => {
        if (!route) {
          return respondNotFound(req, res);
        }

        _route = route;
        _target = target;

        if (target === false) return null;

        const httpProxyOpts = Object.assign(
          { target, secure: true },
          this.opts.httpProxy,
          route.opts.httpProxy
        );

        route.proxy.web(req, res, httpProxyOpts);
        return this._createForwardDefer(route, req);
      })
      .then(() => {
        if (_route && _route.opts.onResponse) {
          return _route.opts.onResponse(req, res, _target);
        }
      })
      .catch(err => {
        if (_route && _route.opts.onError) {
          return _route.opts.onError(err, req, res, _target);
        } else if (this.opts.errorHandler) {
          return this.opts.errorHandler(err, req, res, _target);
        }
        this.handleProxyError(err, req, res);
      });
  });

  httpsServer.on('upgrade', (...args) => this._websocketsUpgrade(...args));

  httpsServer.on('error', err => {
    this.log.error(err, 'HTTPS Server Error');
  });

  httpsServer.on('clientError', err => {
    this.log.error(err, 'HTTPS Client  Error');
  });

  httpsServer.on('connection', conn => this._saveConnection(conn));

  this.log.info('Listening to HTTPS requests on port %s', sslOpts.port);

  httpsServer.listen(sslOpts.port, sslOpts.ip);

  return httpsServer;
};

ReverseProxy.prototype._getProxy = function(src, target, opts = {}) {
  let changeOrigin = opts.changeOrigin;

  //
  // need changeOrigin flag if one of the following is true:
  // - http ==> https
  // - https ===> https and opts.target.ca is defined
  //

  if (
    changeOrigin === undefined &&
    src.hostname !== target.hostname &&
    target.protocol === 'https:'
  ) {
    // different host names with target HTTPS, and user didn't explicitly set changeOrigin
    // so default changeOrigin to true for it to work
    changeOrigin = true;
  }

  if (!changeOrigin) {
    // no change origin required, just use default proxy
    return this.proxy;
  }

  const fields = ['protocol', 'hostname', 'port'];
  const mapper = (x, k) => (x ? `${k},${x}` : '');
  const proxyKey = _.map(_.pick(target, fields), mapper).join('/');

  let proxy = this._proxies[proxyKey];

  if (!proxy) {
    this._proxies[proxyKey] = proxy = this._createProxy({ ...opts, changeOrigin });
  }

  return proxy;
};

ReverseProxy.prototype._createProxy = function(opts) {
  //
  // Create a proxy server with custom application logic
  //
  var proxy = httpProxy.createProxyServer({
    xfwd: opts.xfwd != false,
    prependPath: false,
    secure: opts.secure !== false,
    ..._.pick(opts, ['changeOrigin', 'target', 'agent'])
    /*
      agent: new http.Agent({
        keepAlive: true
      })
      */
  });

  proxy.on('proxyReq', (p, req) => {
    if (req.host != null) {
      p.setHeader('host', req.host);
    }
  });

  //
  // Support NTLM auth
  //
  if (opts.ntlm) {
    proxy.on('proxyRes', proxyRes => {
      var key = 'www-authenticate';
      proxyRes.headers[key] = proxyRes.headers[key] && proxyRes.headers[key].split(',');
    });
  }

  this._setupProxyEvents(proxy);

  return proxy;
};

ReverseProxy.prototype._websocketsUpgrade = function(req, socket, head) {
  socket.on('error', err => {
    this.log.error(err, 'WebSockets error');
  });
  var src = this._getSource(req);
  this._getRouteTarget(src, req).then(({ target }) => {
    this.log.info({ headers: req.headers, target: target }, 'upgrade to websockets');
    if (target) {
      this.proxy.ws(req, socket, head, { target: target });
    } else {
      respondNotFound(req, socket);
    }
  });
};

ReverseProxy.prototype.handleProxyError = function(err, req, res) {
  //
  // Send a 500 http status if headers have been sent
  //

  if (err.code === 'ECONNREFUSED') {
    res.writeHead && res.writeHead(502);
  } else if (!res.headersSent) {
    res.writeHead && res.writeHead(500);
  }

  //
  // Do not log this common error
  //
  if (err.message !== 'socket hang up') {
    this.log.error(err, 'Proxy Error handling', req.url);
  }

  //
  // TODO: if err.code=ECONNREFUSED and there are more servers
  // for this route, try another one.
  //
  res.end(err.code);
};

ReverseProxy.prototype._setupProxyEvents = function(proxy) {
  proxy.on('end', req => {
    if (req[FORWARDING]) {
      req[FORWARDING].resolve();
    }
  });

  proxy.on('error', (err, req, res) => {
    if (req[FORWARDING]) {
      req[FORWARDING].reject(err);
    } else {
      this.handleProxyError(err, req, res);
    }
  });

  proxy.on('econnreset', (err, req, res) => {
    if (req[FORWARDING]) {
      req[FORWARDING].reject(err);
    } else {
      this.handleProxyError(err, req, res);
    }
  });
};

ReverseProxy.prototype._createForwardDefer = function(route, req) {
  if (route.opts.onResponse || route.opts.onError || this.opts.errorHandler) {
    return new Promise((resolve, reject) => {
      req[FORWARDING] = { resolve, reject };
    });
  }
};

const CONNECTION_ID = Symbol('redbird.connection.id');

ReverseProxy.prototype._saveConnection = function(conn) {
  const id = ++this._connId;
  this._connections[id] = conn;
  conn[CONNECTION_ID] = id;
  conn.on('close', () => {
    delete this._connections[id];
  });
};

function shouldRedirectToHttps(certs, src, target, proxy) {
  return certs && src in certs && target.sslRedirect && target.host != proxy.letsencryptHost;
}

ReverseProxy.prototype.setupLetsencrypt = function(log, opts) {
  assert(opts.letsencrypt.path, 'Missing certificate path for Lets Encrypt');

  var letsencryptPort = opts.letsencrypt.port || 3000;
  letsencrypt.init(opts.letsencrypt.path, letsencryptPort, log);

  opts.resolvers = opts.resolvers || [];
  this.letsencryptHost = '127.0.0.1:' + letsencryptPort;
  var targetHost = 'http://' + this.letsencryptHost;
  var challengeResolver = function(host, url) {
    if (/^\/.well-known\/acme-challenge/.test(url)) {
      return targetHost + '/' + host;
    }
  };
  challengeResolver.priority = 9999;
  this.addResolver(challengeResolver);
};

ReverseProxy.prototype.setupHttpsProxy = function(proxy, websocketsUpgrade, log, sslOpts) {};

ReverseProxy.prototype.addResolver = function(resolver) {
  if (this.opts.cluster && cluster.isMaster) return this;

  if (!_.isArray(resolver)) {
    resolver = [resolver];
  }

  resolver.forEach(resolveObj => {
    assert(_.isFunction(resolveObj), 'Resolver must be an invokable function.');

    if (!resolveObj.hasOwnProperty('priority')) {
      resolveObj.priority = 0;
    }

    this.resolvers.push(resolveObj);
  });

  this.resolvers = _.sortBy(_.uniq(this.resolvers), ['priority']).reverse();
};

ReverseProxy.prototype.removeResolver = function(resolver) {
  if (this.opts.cluster && cluster.isMaster) return this;
  // since unique resolvers are not checked for performance,
  // just remove every existence.
  this.resolvers = this.resolvers.filter(function(resolverFn) {
    return resolverFn !== resolver;
  });
};

ReverseProxy.buildTarget = function(target, opts) {
  opts = opts || {};
  target = prepareUrl(target);
  target.sslRedirect = opts.ssl && opts.ssl.redirect !== false;
  target.useTargetHostHeader = opts.useTargetHostHeader === true;
  return target;
};

/**
 Register a new route.

 @src {String|URL} A string or a url parsed by node url module.
 Note that port is ignored, since the proxy just listens to one port.

 @target {String|URL} A string or a url parsed by node url module.
 @opts {Object} Route options.
 */
ReverseProxy.prototype.register = function(src, target, opts) {
  if (this.opts.cluster && cluster.isMaster) return this;

  if (src && src.src) {
    target = src.target;
    opts = src;
    src = src.src;
  } else if (target && target.target) {
    opts = target;
    target = target.target;
  }

  assert(src && target, 'Cannot register a new route with unspecified src or target');

  var routing = this.routing;

  src = prepareUrl(src);
  target = ReverseProxy.buildTarget(target, opts);

  if (opts) {
    var ssl = opts.ssl;
    if (ssl) {
      assert(
        this.httpsServers.length > 0,
        'Cannot register https routes without defining a ssl port'
      );

      if (!this.certs[src.hostname]) {
        if (ssl.key || ssl.cert || ssl.ca) {
          this.certs[src.hostname] = createCredentialContext(ssl.key, ssl.cert, ssl.ca);
        } else if (ssl.letsencrypt) {
          if (!this.opts.letsencrypt || !this.opts.letsencrypt.path) {
            console.error('Missing certificate path for Lets Encrypt');
            return;
          }
          this.log.info('Getting Lets Encrypt certificates for %s', src.hostname);
          this.updateCertificates(
            src.hostname,
            ssl.letsencrypt.email,
            ssl.letsencrypt.production,
            this.opts.letsencrypt.renewWithin || ONE_MONTH
          );
        } else {
          // Trigger the use of the default certificates.
          this.certs[src.hostname] = void 0;
        }
      }
    }
  }

  var host = (routing[src.hostname] = routing[src.hostname] || []);
  var pathname = src.pathname || '/';
  var route = _.find(host, { path: pathname });

  if (!route) {
    const proxy = this._getProxy(src, target, opts);
    route = { path: pathname, rr: 0, urls: [], opts: Object.assign({}, opts), proxy };
    host.push(route);

    //
    // Sort routes
    //
    routing[src.hostname] = _.sortBy(host, function(_route) {
      return -_route.path.length;
    });
  }

  route.urls.push(target);

  this.log.info({ from: src, to: target }, 'Registered a new route');
  return this;
};

ReverseProxy.prototype.updateCertificates = function(
  domain,
  email,
  production,
  renewWithin,
  renew
) {
  return letsencrypt.getCertificates(domain, email, production, renew, this.log).then(
    certs => {
      if (certs) {
        var opts = {
          key: certs.privkey,
          cert: certs.cert + certs.chain
        };
        this.certs[domain] = tls.createSecureContext(opts).context;

        //
        // TODO: cluster friendly
        //
        var renewTime = certs.expiresAt - Date.now() - renewWithin;
        renewTime =
          renewTime > 0 ? renewTime : this.opts.letsencrypt.minRenewTime || 60 * 60 * 1000;

        this.log.info('Renewal of %s in %s days', domain, Math.floor(renewTime / ONE_DAY));

        function renewCertificate() {
          this.log.info('Renewing letscrypt certificates for %s', domain);
          this.updateCertificates(domain, email, production, renewWithin, true);
        }

        this.certs[domain].renewalTimeout = safe.setTimeout(renewCertificate, renewTime);
      } else {
        //
        // TODO: Try again, but we need an exponential backof to avoid getting banned.
        //
        this.log.info('Could not get any certs for %s', domain);
      }
    },
    err => {
      console.error('Error getting LetsEncrypt certificates', err);
    }
  );
};

ReverseProxy.prototype.unregister = function(src, target) {
  if (this.opts.cluster && cluster.isMaster) return this;

  if (!src) {
    return this;
  }

  src = prepareUrl(src);
  var routes = this.routing[src.hostname] || [];
  var pathname = src.pathname || '/';
  var i;

  for (i = 0; i < routes.length; i++) {
    if (routes[i].path === pathname) {
      break;
    }
  }

  if (i < routes.length) {
    var route = routes[i];

    if (target) {
      target = prepareUrl(target);
      _.remove(route.urls, function(url) {
        return url.href === target.href;
      });
    } else {
      route.urls = [];
    }

    if (route.urls.length === 0) {
      routes.splice(i, 1);
      var certs = this.certs;
      if (certs) {
        if (certs[src.hostname] && certs[src.hostname].renewalTimeout) {
          safe.clearTimeout(certs[src.hostname].renewalTimeout);
        }
        delete certs[src.hostname];
      }
    }

    this.log.info({ from: src, to: target }, 'Unregistered a route');
  }
  return this;
};

ReverseProxy.prototype._defaultResolver = function(host, url) {
  // Given a src resolve it to a target route if any available.
  if (!host) {
    return;
  }

  url = url || '/';

  var routes = this.routing[host];
  var i = 0;

  if (routes) {
    var len = routes.length;

    //
    // Find path that matches the start of req.url
    //
    for (i = 0; i < len; i++) {
      var route = routes[i];

      if (route.path === '/' || startsWith(url, route.path)) {
        return route;
      }
    }
  }
};

ReverseProxy.prototype._defaultResolver.priority = 0;

/**
 * Resolves to route
 * @param host
 * @param url
 * @returns {*}
 */
ReverseProxy.prototype.resolve = function(host, url, req) {
  var resolvedValue;
  var promiseArray = [];

  host = host && host.toLowerCase();
  for (var i = 0; i < this.resolvers.length; i++) {
    promiseArray.push(this.resolvers[i].call(this, host, url, req));
  }

  return Promise.all(promiseArray)
    .then(function(resolverResults) {
      for (var i = 0; i < resolverResults.length; i++) {
        var route = resolverResults[i];

        if (route && (route = ReverseProxy.buildRoute(route))) {
          // ensure resolved route has path that prefixes URL
          // no need to check for native routes.
          if (!route.isResolved || route.path === '/' || startsWith(url, route.path)) {
            return route;
          }
        }
      }
    })
    .catch(function(error) {
      console.error('Resolvers error:', error);
    });
};

ReverseProxy.buildRoute = function(route) {
  if (!_.isString(route) && !_.isObject(route)) {
    return null;
  }

  if (_.isObject(route) && route.hasOwnProperty('urls') && route.hasOwnProperty('path')) {
    // default route type matched.
    return route;
  }

  var cacheKey = _.isString(route) ? route : hash(route);
  var entry = routeCache.get(cacheKey);
  if (entry) {
    return entry;
  }

  var routeObject = { rr: 0, isResolved: true };
  if (_.isString(route)) {
    routeObject.urls = [ReverseProxy.buildTarget(route)];
    routeObject.path = '/';
  } else {
    if (!route.hasOwnProperty('url')) {
      return null;
    }

    routeObject.urls = (_.isArray(route.url) ? route.url : [route.url]).map(function(url) {
      return ReverseProxy.buildTarget(url, route.opts || {});
    });

    routeObject.path = route.path || '/';
  }
  routeCache.set(cacheKey, routeObject);
  return routeObject;
};

ReverseProxy.prototype._getRouteTarget = function(src, req, res) {
  var url = req.url;

  return this.resolve(src, url, req).then(route => {
    if (!route) {
      this.log.warn({ src: src, url: url }, 'no valid route found for given source');
      return {};
    }

    var pathname = route.path;
    if (pathname.length > 1) {
      //
      // remove prefix from src
      //
      req._url = url; // save original url
      req.url = url.substr(pathname.length) || '';
    }

    //
    // Perform Round-Robin on the available targets
    // TODO: if target errors with EHOSTUNREACH we should skip this
    // target and try with another.
    //
    var urls = route.urls;
    var j = route.rr;
    route.rr = (j + 1) % urls.length; // get and update Round-robin index.
    var target = route.urls[j];

    //
    // Fix request url if targetname specified.
    //
    if (target.pathname) {
      if (req.url) {
        if (req.url[0] === '?') {
          // avoid joining with a query only URL because that would add a /
          req.url = target.pathname + req.url;
        } else {
          req.url = path.posix.join(target.pathname, req.url);
        }
      } else {
        req.url = target.pathname;
      }
    }

    //
    // Host headers are passed through from the source by default
    // Often we want to use the host header of the target instead
    //
    if (target.useTargetHostHeader === true) {
      req.host = target.host;
    }

    this.log.info('Proxying %s to %s', src + url, path.posix.join(target.host, req.url));

    if (route.opts.onRequest) {
      const x = route.opts.onRequest(req, res, target);
      if (x !== undefined) {
        return { route, target: x };
      }
    }

    return { route, target };
  });
};

ReverseProxy.prototype._getSource = function(req) {
  if (this.opts.preferForwardedHost === true && req.headers['x-forwarded-host']) {
    return req.headers['x-forwarded-host'].split(':')[0];
  }
  if (req.headers.host) {
    return req.headers.host.split(':')[0];
  }
};

ReverseProxy.prototype.close = function(shutdown) {
  try {
    if (shutdown && !_.isEmpty(this._connections)) {
      const connections = this._connections;
      this._connections = {};
      setTimeout(() => {
        for (let id in connections) {
          const conn = connections[id];
          conn.end();
        }
      }, 250);
    }
    return Promise.all(
      []
        .concat(this.servers, this.httpsServers)
        .map(s => s && new Promise(resolve => s.close(resolve)))
    );
  } catch (err) {
    // Ignore for now...
  }
};

//
// Helpers
//
/**
  Routing table structure. An object with hostname as key, and an array as value.
  The array has one element per path associated to the given hostname.
  Every path has a Round-Robin value (rr) and urls array, with all the urls available
  for this target route.

  {
    hostA :
      [
        {
          path: '/',
          rr: 3,
          urls: []
        }
      ]
  }
*/

var respondNotFound = function(req, res) {
  res.statusCode = 404;
  res.write('Not Found');
  res.end();
};

ReverseProxy.prototype.notFound = function(callback) {
  assert(typeof callback == 'function', 'notFound callback is not a function');
  respondNotFound = callback;
};

//
// Redirect to the HTTPS proxy
//
function redirectToHttps(req, res, target, ssl, log) {
  req.url = req._url || req.url; // Get the original url since we are going to redirect.

  var targetPort = ssl.redirectPort || ssl.port;
  var hostname = req.headers.host.split(':')[0] + (targetPort ? ':' + targetPort : '');
  var url = 'https://' + path.posix.join(hostname, req.url);
  log.info('Redirecting %s to %s', path.posix.join(req.headers.host, req.url), url);
  //
  // We can use 301 for permanent redirect, but its bad for debugging, we may have it as
  // a configurable option.
  //
  res.writeHead(302, { Location: url });
  res.end();
}

function startsWith(input, str) {
  return (
    input.slice(0, str.length) === str &&
    (input.length === str.length || input[str.length] === '/' || input[str.length] === '?')
  );
}

function prepareUrl(url) {
  url = _.clone(url);
  if (_.isString(url)) {
    url = setHttp(url);

    assert(
      validUrl.isHttpUri(url) || validUrl.isHttpsUri(url),
      'uri is not a valid http uri ' + url
    );

    url = parseUrl(url);
  }
  return url;
}

function getCertData(pathname, unbundle) {
  // TODO: Support input as Buffer, Stream or Pathname.

  if (pathname) {
    if (_.isArray(pathname)) {
      var pathnames = pathname;
      return _.flatten(
        _.map(pathnames, function(_pathname) {
          return getCertData(_pathname, unbundle);
        })
      );
    } else if (fs.existsSync(pathname)) {
      if (unbundle) {
        return unbundleCert(fs.readFileSync(pathname, 'utf8'));
      } else {
        return fs.readFileSync(pathname, 'utf8');
      }
    }
  }
}

/**
 Unbundles a file composed of several certificates.
 http://www.benjiegillam.com/2012/06/node-dot-js-ssl-certificate-chain/
 */
function unbundleCert(bundle) {
  var chain = bundle.trim().split('\n');

  var ca = [];
  var cert = [];

  for (var i = 0, len = chain.length; i < len; i++) {
    var line = chain[i].trim();
    if (!(line.length !== 0)) {
      continue;
    }
    cert.push(line);
    if (line.match(/-END CERTIFICATE-/)) {
      var joined = cert.join('\n');
      ca.push(joined);
      cert = [];
    }
  }
  return ca;
}

var tls = require('tls');
function createCredentialContext(key, cert, ca) {
  var opts = {};

  opts.key = getCertData(key);
  opts.cert = getCertData(cert);
  if (ca) {
    opts.ca = getCertData(ca, true);
  }

  var credentials = tls.createSecureContext(opts);

  return credentials.context;
}

//
// https://stackoverflow.com/questions/18052919/javascript-regular-expression-to-add-protocol-to-url-string/18053700#18053700
// Adds http protocol if non specified.
function setHttp(link) {
  if (link.search(/^http[s]?\:\/\//) === -1) {
    link = 'http://' + link;
  }
  return link;
}

module.exports = ReverseProxy;
