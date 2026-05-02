// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch mock utility for testing OpenFGA client.
 * Allows intercepting fetch calls and returning configurable responses.
 */

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type FetchMock = {
  mockResponse: (response: MockResponse) => void;
  mockNetworkError: (message: string) => void;
  getLastRequest: () => { url: string; options: RequestInit } | null;
  getRequestCount: () => number;
  reset: () => void;
  fetchFn: (url: string, options?: RequestInit) => Promise<Response>;
};

export function createFetchMock(): FetchMock {
  let lastRequest: { url: string; options: RequestInit } | null = null;
  let requestCount = 0;
  let mockResponse: MockResponse = { ok: true, status: 200, statusText: 'OK', body: {} };
  let shouldThrowNetworkError = false;
  let networkErrorMessage = 'Network error';

  const fetchFn = async (url: string, options: RequestInit): Promise<Response> => {
    lastRequest = { url, options };
    requestCount++;

    if (shouldThrowNetworkError) {
      throw new Error(networkErrorMessage);
    }

    const headers = new Headers();
    if (mockResponse.headers) {
      for (const [key, value] of Object.entries(mockResponse.headers)) {
        headers.set(key, value);
      }
    }
    headers.set('Content-Type', 'application/json');

    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      statusText: mockResponse.statusText,
      headers,
      json: async () => mockResponse.body as Record<string, unknown>,
      text: async () => JSON.stringify(mockResponse.body),
    } as unknown as Response;
  };

  return {
    mockResponse(response: MockResponse) {
      mockResponse = response;
      shouldThrowNetworkError = false;
    },
    mockNetworkError(message: string) {
      shouldThrowNetworkError = true;
      networkErrorMessage = message;
    },
    getLastRequest() {
      return lastRequest;
    },
    getRequestCount() {
      return requestCount;
    },
    reset() {
      lastRequest = null;
      requestCount = 0;
      mockResponse = { ok: true, status: 200, statusText: 'OK', body: {} };
      shouldThrowNetworkError = false;
      networkErrorMessage = 'Network error';
    },
    fetchFn,
  };
}