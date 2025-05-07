import axios from "axios";
import http from "http";
import https from "https";
import axiosRetry from "axios-retry";
import logger from "./logger.js";

/**
 * Create a configured Axios instance with retry support and logging.
 * @param {Object} options
 * @param {string} options.baseURL - The base URL for requests.
 * @param {Object} options.headers - Default headers to include.
 * @param {number} options.timeout - Request timeout in ms.
 * @param {number} options.maxRetries - Number of retry attempts for network errors.
 * @returns {AxiosInstance}
 */
export function createHttpClient({ baseURL, headers = {}, timeout = 30000, maxRetries = 0 }) {
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const client = axios.create({ baseURL, headers, timeout, httpAgent, httpsAgent });
  if (maxRetries > 0) {
    axiosRetry(client, {
      retries: maxRetries,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error)
    });
  }
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      logger.error(`HTTP request failed: ${error.message}`, {
        url: error.config?.url,
        method: error.config?.method,
        status: error.response?.status
      });
      return Promise.reject(error);
    }
  );
  return client;
} 