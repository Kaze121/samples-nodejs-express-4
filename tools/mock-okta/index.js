/*!
 * Copyright (c) 2015-2016, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 */

/* eslint no-param-reassign:0, no-console:0, no-underscore-dangle:0 */

'use strict';

const connect = require('connect');
const http = require('http');
const yakbak = require('yakbak');
const url = require('url');
const chalk = require('chalk');
const zlib = require('zlib');
const path = require('path');
const parseArgs = require('minimist');
const debug = require('debug')('mock-okta');
const util = require('./util');
const keys = require('./keys-test');
const config = require('../../.samples.config.json').oktaSample.mockOkta;
const clientConfig = require('../../.samples.config.json').oktaSample.oidc;
const textParser = require('body-parser').text({ type: '*/*' });
const Readable = require('stream').Readable;

// ----------------------------------------------------------------------------
// Command line arguments

/**
 * There are two additional command line arguments that you can use:
 *
 * 1. Record new tapes
 *    $ node tools/mock-okta --record
 *
 * 2. Debug mode
 *    $ DEBUG=mock-okta node tools/mock-okta --record
 */

const args = parseArgs(process.argv.slice(2));

let record = false;
if (args.record) {
  record = true;
}

// ----------------------------------------------------------------------------
// Mem storage for storing state and nonce across redirects - lookup from
// okta_key and code

const store = {};

// ----------------------------------------------------------------------------
// Helper functions

/**
 * Gets cookie name from a cookie string
 */
function getCookieName(cookieStr) {
  return cookieStr.split('=')[0].trim();
}

/**
 * Helper function that transforms and sends the response headers
 */
function sendHeaders(res, headers, data, setHeader) {
  // If data.cookies exists, it means that we need to delete them in the
  // response headers unless they are already being set by the server
  if (data.cookie) {
    if (!headers['set-cookie']) {
      headers['set-cookie'] = [];
    }

    // Construct a map of cookies that are being set on this response
    const resCookies = {};
    headers['set-cookie'].forEach((cookieStr) => {
      resCookies[getCookieName(cookieStr)] = true;
    });

    debug('Cookies that are being set by the server in the response:');
    debug(headers['set-cookie']);
    debug(resCookies);

    debug('Cookies that we want to delete from the incoming request:');
    debug(data.cookie);

    const deleteCookies = data.cookie.split(';')
      .filter(cookieStr => !resCookies[getCookieName(cookieStr)])
      .map((cookieStr) => {
        const name = getCookieName(cookieStr);
        return `${name}=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      });

    debug('Cookies that we will actually delete after comparison:');
    debug(deleteCookies);

    headers['set-cookie'] = deleteCookies.concat(headers['set-cookie']);

    debug('Final set cookies value');
    debug(headers['set-cookie']);
  }

  // Transform and send the headers
  const mapped = util.mapCachedHeadersToResponse(headers, data, record);
  Object.keys(mapped).forEach((key) => {
    setHeader.call(res, key, mapped[key]);
  });
}

/**
 * Helper function that concatenates and transforms the response buffer chunks
 */
function getResponseBody(headers, chunks, data) {
  const gzipped = headers['content-encoding'] === 'gzip';
  const contentType = headers['content-type'];
  const attemptTransform = contentType && (
    contentType.indexOf('text/html') > -1 ||
    contentType.indexOf('application/json') > -1
  );

  let resBody = Buffer.concat(chunks);

  if (attemptTransform) {
    if (gzipped) {
      resBody = zlib.gunzipSync(resBody);
    }
    const str = util.mapCachedBodyToResponse(resBody.toString('utf8'), data, record);
    resBody = new Buffer(str, 'utf8');
    if (gzipped) {
      resBody = zlib.gzipSync(resBody);
    }
  }

  return resBody;
}

// ----------------------------------------------------------------------------
// Middleware

/**
 * For the /oauth2/default/v1/keys request, skip the proxy and return our mock JWKS.
 */
function handleKeys(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ keys: [keys.publicJwk] }));
}

/**
 * For the /oauth2/default/v1/token request, we need to replace the dynamic state
 * in the request form-body with a known state
 * This is to ensure that the right tape is requested in yakbak,
 * which uses body to hash-request the tape
 *
 * In this case, a known state is the state that was generated while recording
 */
function handleToken(req, res, next) {
  textParser(req, res, () => {
    if (!req.body) return;
    // Express openid-client sends the dynamic state parameter to token request
    // We need to replace it with a "known" state, so that we hit the right tape each time
    req.body = req.body.replace(`state=${store['state']}`, 'state=STATE');

    // Spring back-end sends the client-id and client-secret in the token request.
    // We use express back-end to record tapes, which sends the state value in token request
    // During playback, we replace the spring back-end's token request body with state, so that we hit the right tape
    req.body = req.body.replace(`client_id=${clientConfig.clientId}&client_secret=${clientConfig.clientSecret}`, 
                                'state=STATE');

    // Massaging the request headers to match the change in body length
    req.headers['content-length'] = `${req.body.length}`;

    // Spring back-end doesn't use Basic Auth for token requests whereas express back-end does
    // By now, you should have figured out that we modify spring back-end requests to match the express back-end
    const value = new Buffer(`${clientConfig.clientId}:${clientConfig.clientSecret}`).toString('base64');
    req.headers['authorization'] = `Basic ${value}`

    const stream = new Readable();
    stream._read = () => {};
    stream.push(req.body);
    stream.push(null);
    delete req.body;
    req.on = stream.on.bind(stream);
    next();
  });
}

/**
 * Transforms the incoming request to match a pre-recorded response that is
 * stored in the tapes/ dir, and rewrites the response to work with the
 * current request.
 */
function transform(req, res, next) {
  debug(`${chalk.bold.yellow(req.method)} ${chalk.bold.yellow(req.url)}`);

  const query = util.parseQuery(req.url);
  const data = util.mapRequestToCache(req, record);

  // Request properties that are hashed by the incoming-message-hash module
  const reqParts = url.parse(req.url, true);
  const hashedReqParams = {
    httpVersion: req.httpVersion,
    method: req.method,
    pathname: reqParts.pathname,
    query: reqParts.query,
    headers: req.headers,
    trailers: req.trailers,
  };
  debug(chalk.bold('Looking up mapped request in cached tapes'));
  debug(JSON.stringify(hashedReqParams, null, 2));

  // It is important to use a proxy host that is different from the local
  // server - for example, using localhost:3000 for the server and
  // localhost:7777 will not work because cookies are shared across ports.
  data.proxy = `${config.proxy}:${config.port}`;
  data.proxied = config.proxied;
  data.cdn = config.cdn;

  // Store query params from the /authorize request to retrieve later when
  // the user makes a request to the /token endpoint
  if (data.isAuthorizeReq) {
    debug('/authorize request, storing data');
    debug(data);
    store[data.state] = { state: data.state, nonce: data.nonce };
    store['state'] = data.state;
  }

  // When we are redirecting back to the client,
  // we need to restore the state to what was originally set
  if (data.isRedirectCallback) {
    debug('Need to restore the state');
    debug(store);
    data.state = store['state'];
  }

  // Retrieve stored data when okta_key is present - this is needed in the
  // authorize flow when there are multiple redirects (i.e. no sessionToken
  // passed)
  if (query.okta_key) {
    debug(`okta_key '${query.okta_key}' found in url - retrieving data`);
    debug(store[query.okta_key]);
    Object.assign(data, store[query.okta_key]);
  }

  // Retrieve stored data when code is present - this is used in the token
  // request
  if (query.code) {
    debug(`code '${query.code}' found in url, retrieving data`);
    debug(store[query.code]);
    data.isTokenReq = true;
    Object.assign(data, store[query.code]);
  }

  // Override the original res.setHeader - to override values, we queue the
  // setHeader calls and batch transform/send them when the response is sent
  const setHeader = res.setHeader;
  const resHeaders = { 'transfer-encoding': 'chunked' };
  res.setHeader = (name, value) => {
    resHeaders[name] = value;
  };

  // Override the original res.write - collect all res.write calls, remember
  // the encoding, and send the entire response body when res.end is called.
  // This is necessary because it's possible that the part of the response
  // we want to modify (links to resources, etc) can be split between two
  // response chunks.
  let resEncoding;
  const resChunks = [];
  const write = res.write;
  res.write = (chunk, encoding) => {
    resEncoding = encoding;
    resChunks.push(chunk);
  };

  // Override the original res.end - send headers and response body, and store
  // any values that need to be remembered in subsequent requests.
  const end = res.end;
  res.end = () => {
    sendHeaders(res, resHeaders, data, setHeader);

    const redirectUrl = res._headers && res._headers.location;
    const redirectQuery = (redirectUrl && util.parseQuery(redirectUrl)) || {};

    // Capture the okta_key from the nested fromURI param
    const fromUri = (Object.keys(redirectQuery).length !== 0 &&
      redirectQuery.fromURI &&
      util.parseQuery(redirectQuery.fromURI)) || {};

    // Store data if we're redirecting between authorization flow pages
    if (data.isAuthorizeReq && data.responseMode === 'query' && fromUri.okta_key) {
      debug(`Storing okta_key properties: ${fromUri.okta_key}`);
      debug(data);
      store[fromUri.okta_key] = { state: data.state, nonce: data.nonce };
    }

    // Store data if we're redirecting to the redirectUri in preparation for
    // a token request
    if (redirectQuery.code) {
      debug(`Storing properties for code ${redirectQuery.code} from state ${redirectQuery.state}`);
      debug(store[redirectQuery.state]);
      store[redirectQuery.code] = store[redirectQuery.state];
    }

    debug(`Sending response with statusCode ${chalk.bold(res.statusCode)}`);
    write.call(res, getResponseBody(resHeaders, resChunks, data), resEncoding);
    end.call(res);
  };

  next();
}

// ----------------------------------------------------------------------------
// Initialization

const app = connect();
const tapeDir = path.resolve(__dirname, 'tapes');

app.use('/oauth2/default/v1/keys', handleKeys);
app.use('/oauth2/default/v1/token', handleToken);
app.use(transform);
app.use(yakbak(config.proxied, { dirname: tapeDir, noRecord: !record }));

http.createServer(app).listen(config.port);

console.log(`Tapes stored in: ${tapeDir}`);
console.log(`Server started: ${config.proxy}:${config.port}`);
console.log(`Proxying: ${config.proxied}`);
