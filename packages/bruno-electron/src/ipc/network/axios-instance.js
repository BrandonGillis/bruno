const URL = require('url');
const Socket = require('net').Socket;
const axios = require('axios');
const dnsPromises = require('dns').promises;
const connectionCache = new Map(); // Cache to store checkConnection() results

const LOCAL_IPV6 = '::1';
const LOCAL_IPV4 = '127.0.0.1';
const LOCALHOST = 'localhost';

const getTld = (hostname) => {
  if (!hostname) {
    return '';
  }

  return hostname.substring(hostname.lastIndexOf('.') + 1);
};

const checkConnection = (host, port) =>
  new Promise((resolve) => {
    const key = `${host}:${port}`;
    const cachedResult = connectionCache.get(key);

    if (cachedResult !== undefined) {
      resolve(cachedResult);
    } else {
      const socket = new Socket();

      socket.once('connect', () => {
        socket.end();
        connectionCache.set(key, true); // Cache successful connection
        resolve(true);
      });

      socket.once('error', () => {
        // we don't cache here, we want to test the connection everytime if it fails.
        resolve(false);
      });

      // Try to connect to the host and port
      socket.connect(port, host);
    }
  });

const localhostLookup = (url, hostname, options, callback) => {
  const port = Number(url.port) || (url.protocol.includes('https') ? 443 : 80);

  dnsPromises
    .lookup(hostname, options)
    .then((res) => handleSuccessfulLookup(port, res, callback))
    .catch(() => handleCustomLookup(port, callback));
};

const handleSuccessfulLookup = (port, res, callback) => {
  /**
   * If we're here it means that localhost or *.localhost resolved to an IP address inside the hosts file,
   * but we still need to check connectivity, as localhost could resolve to 127.0.0.1, but a server could listen on ::1.
   */
  console.log('DNS lookup successful, checking connection');
  checkConnection(res.address, port).then((success) =>
    success ? callback(null, res.address, res.family) : handleCustomLookup(port, callback)
  );
};

const handleCustomLookup = (port, callback) => {
  console.log(`DNS lookup failed, falling back to custom lookup.`);
  checkConnection(LOCAL_IPV6, port).then((useIpv6) => {
    const ip = useIpv6 ? LOCAL_IPV6 : LOCAL_IPV4;
    callback(null, ip, useIpv6 ? 6 : 4);
  });
};

/**
 * Function that configures axios with timing interceptors
 * Important to note here that the timings are not completely accurate.
 * @see https://github.com/axios/axios/issues/695
 * @returns {axios.AxiosInstance}
 */
function makeAxiosInstance() {
  /** @type {axios.AxiosInstance} */
  const instance = axios.create();

  instance.interceptors.request.use(async (config) => {
    const url = URL.parse(config.url);

    // Resolve all *.localhost to localhost and check if it should use IPv6 or IPv4
    // RFC: 6761 section 6.3 (https://tools.ietf.org/html/rfc6761#section-6.3)
    // @see https://github.com/usebruno/bruno/issues/124
    if (getTld(url.hostname) === LOCALHOST || url.hostname === LOCAL_IPV4 || url.hostname === LOCAL_IPV6) {
      // use custom DNS lookup for localhost
      config.lookup = (hostname, options, callback) => {
        localhostLookup(url, hostname, options, callback);
      };
    }

    config.headers['request-start-time'] = Date.now();
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      const end = Date.now();
      const start = response.config.headers['request-start-time'];
      response.headers['request-duration'] = end - start;
      return response;
    },
    (error) => {
      if (error.response) {
        const end = Date.now();
        const start = error.config.headers['request-start-time'];
        error.response.headers['request-duration'] = end - start;
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

module.exports = {
  makeAxiosInstance
};
