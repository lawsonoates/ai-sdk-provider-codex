import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type CodexFetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
export type CodexFetch = typeof fetch;

export interface CreateCodexFetchOptions {
  tokenPath?: string;
  fetch?: CodexFetchImplementation;
  endpoint?: string;
  refreshSkewMs?: number;
  userAgent?: string;
}

interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  idToken?: string;
}

interface CodexAuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string | null;
  } | null;
  last_refresh?: string | null;
  [key: string]: unknown;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: { id: string }[];
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_RESPONSES_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_AUTH_PATH = "~/.codex/auth.json";
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const CODEX_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const expandHome = (value: string): string => {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
};

const userAgentHeader = (userAgent?: string): Record<string, string> =>
  userAgent ? { "User-Agent": userAgent } : {};

const getRequestUrl = (requestInput: string | URL | Request): URL => {
  if (requestInput instanceof URL) {
    return requestInput;
  }
  if (requestInput instanceof Request) {
    return new URL(requestInput.url);
  }
  return new URL(requestInput);
};

const shouldRewriteToCodex = (url: URL): boolean =>
  url.pathname.endsWith("/v1/responses") ||
  url.pathname.endsWith("/chat/completions");

const collectHeaders = (
  requestInput: string | URL | Request,
  init?: RequestInit
): Headers => {
  const headers = new Headers(
    requestInput instanceof Request ? requestInput.headers : undefined
  );

  if (!init?.headers) {
    return headers;
  }

  const initHeaders = new Headers(init.headers);
  for (const [key, value] of initHeaders) {
    headers.set(key, value);
  }
  return headers;
};

const parseJwtClaims = (token: string): IdTokenClaims | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
};

const extractAccountIdFromClaims = (
  claims: IdTokenClaims
): string | undefined =>
  claims.chatgpt_account_id ??
  claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
  claims.organizations?.[0]?.id;

const extractAccountId = (
  tokens: Pick<TokenResponse, "id_token" | "access_token">
): string | undefined => {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims ? extractAccountIdFromClaims(claims) : undefined;
    if (accountId) {
      return accountId;
    }
  }

  const accessClaims = parseJwtClaims(tokens.access_token);
  return accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined;
};

const parseJwtExpiration = (token: string): number | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

const lastRefreshExpiration = (auth: CodexAuthJson): number | undefined => {
  if (typeof auth.last_refresh !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(auth.last_refresh);
  return Number.isFinite(timestamp)
    ? timestamp + CODEX_REFRESH_INTERVAL_MS
    : undefined;
};

const readCodexAuthJson = async (path: string): Promise<CodexAuthJson> => {
  const parsed = JSON.parse(await readFile(path, "utf-8"));
  return isRecord(parsed) ? (parsed as CodexAuthJson) : {};
};

const writeCodexAuthJson = async (
  path: string,
  value: CodexAuthJson
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
};

const normalizeCodexAuthJson = (auth: CodexAuthJson): CodexTokens | null => {
  const { tokens } = auth;
  if (!tokens) {
    return null;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  if (!accessToken || !refreshToken) {
    return null;
  }

  const idToken = tokens.id_token;
  const expiresAt =
    parseJwtExpiration(accessToken) ?? lastRefreshExpiration(auth);
  if (!expiresAt) {
    return null;
  }

  const accountId =
    tokens.account_id ??
    extractAccountId({
      access_token: accessToken,
      id_token: idToken,
    });

  return {
    accessToken,
    expiresAt,
    refreshToken,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
};

const readTokens = async (path: string): Promise<CodexTokens | null> => {
  try {
    return normalizeCodexAuthJson(await readCodexAuthJson(path));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
};

const writeTokens = async (
  path: string,
  tokens: CodexTokens
): Promise<void> => {
  let current: CodexAuthJson;
  try {
    current = await readCodexAuthJson(path);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    current = {};
  }

  await writeCodexAuthJson(path, {
    ...current,
    OPENAI_API_KEY: current.OPENAI_API_KEY ?? null,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: tokens.accessToken,
      account_id: tokens.accountId ?? current.tokens?.account_id ?? null,
      id_token: tokens.idToken ?? current.tokens?.id_token,
      refresh_token: tokens.refreshToken,
    },
  });
};

const refreshCodexTokens = async (
  refreshToken: string,
  options: {
    fetch: CodexFetchImplementation;
    userAgent?: string;
    previousAccountId?: string;
    previousIdToken?: string;
  }
): Promise<CodexTokens> => {
  const response = await options.fetch(`${CODEX_ISSUER}/oauth/token`, {
    body: new URLSearchParams({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...userAgentHeader(options.userAgent),
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const refreshed = (await response.json()) as TokenResponse;
  const idToken = refreshed.id_token ?? options.previousIdToken;
  const accountId =
    extractAccountId({
      access_token: refreshed.access_token,
      id_token: idToken,
    }) ?? options.previousAccountId;

  return {
    accessToken: refreshed.access_token,
    expiresAt:
      Date.now() + (refreshed.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
    refreshToken: refreshed.refresh_token ?? refreshToken,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
};

const fetchCodexRequest = (
  fetchImpl: CodexFetchImplementation,
  requestInput: string | URL | Request,
  init: RequestInit | undefined,
  tokens: CodexTokens,
  endpoint: string
): Promise<Response> => {
  const requestUrl = getRequestUrl(requestInput);
  const rewrittenUrl = shouldRewriteToCodex(requestUrl)
    ? new URL(endpoint)
    : requestUrl;
  const headers = collectHeaders(requestInput, init);

  headers.delete("authorization");
  headers.delete("Authorization");
  headers.set("authorization", `Bearer ${tokens.accessToken}`);
  if (tokens.accountId) {
    headers.set("ChatGPT-Account-Id", tokens.accountId);
  }

  if (requestInput instanceof Request) {
    return fetchImpl(new Request(rewrittenUrl.toString(), requestInput), {
      ...init,
      headers,
    });
  }

  return fetchImpl(rewrittenUrl, {
    ...init,
    headers,
  });
};

export const createFetch = (
  options: CreateCodexFetchOptions = {}
): CodexFetch => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? CODEX_RESPONSES_ENDPOINT;
  const tokenPath = expandHome(options.tokenPath ?? DEFAULT_AUTH_PATH);
  const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  let refreshPromise: Promise<CodexTokens> | undefined;

  const refreshTokens = (current: CodexTokens): Promise<CodexTokens> => {
    refreshPromise ??= (async (): Promise<CodexTokens> => {
      try {
        const tokens = await refreshCodexTokens(current.refreshToken, {
          fetch: fetchImpl,
          previousAccountId: current.accountId,
          previousIdToken: current.idToken,
          userAgent: options.userAgent,
        });
        await writeTokens(tokenPath, tokens);
        return tokens;
      } finally {
        refreshPromise = undefined;
      }
    })();

    return refreshPromise;
  };

  const getUsableTokens = async (
    forceRefresh = false
  ): Promise<CodexTokens> => {
    const tokens = await readTokens(tokenPath);
    if (!tokens) {
      throw new Error(
        `Codex OAuth tokens were not found at ${tokenPath}. Authenticate with Codex first.`
      );
    }

    if (forceRefresh || tokens.expiresAt <= Date.now() + refreshSkewMs) {
      return refreshTokens(tokens);
    }

    return tokens;
  };

  const codexFetch = async (
    requestInput: string | URL | Request,
    init?: RequestInit
  ) => {
    const firstTokens = await getUsableTokens();
    const firstResponse = await fetchCodexRequest(
      fetchImpl,
      requestInput,
      init,
      firstTokens,
      endpoint
    );

    if (firstResponse.status !== 401) {
      return firstResponse;
    }

    const refreshed = await getUsableTokens(true);
    return fetchCodexRequest(
      fetchImpl,
      requestInput,
      init,
      refreshed,
      endpoint
    );
  };

  const fetchExtras =
    "preconnect" in fetchImpl && typeof fetchImpl.preconnect === "function"
      ? { preconnect: fetchImpl.preconnect.bind(fetchImpl) }
      : {};

  Object.assign(codexFetch, fetchExtras);

  return codexFetch as CodexFetch;
};
