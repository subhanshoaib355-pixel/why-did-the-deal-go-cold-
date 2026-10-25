import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getZetarisToken } from "./zetaris-auth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(here, ".zetaris-auth.json");
const BASE_URL = (process.env.ZETARIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ORG_ID = process.env.ZETARIS_ORG_ID || "1";

type AuthCache = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

function loadCache(): AuthCache {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthCache;
  } catch {
    return {};
  }
}

function saveCache(cache: AuthCache): void {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cache, null, 2));
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Org-ID": ORG_ID,
    "X-Request-ID": crypto.randomUUID(),
  };
}

async function refreshAccessToken(): Promise<string> {
  const cache = loadCache();
  const refreshToken = process.env.ZETARIS_REFRESH_TOKEN || cache.refreshToken;
  if (!refreshToken) {
    throw new Error("Set ZETARIS_REFRESH_TOKEN (Bearer value from the refresh cURL).");
  }

  const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
    method: "POST",
    headers: authHeaders(refreshToken),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`auth refresh failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text) as {
    idToken?: string;
    token?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  const accessToken = json.idToken ?? json.accessToken ?? json.token;
  if (!accessToken) {
    throw new Error("auth refresh did not return an access token.");
  }

  const ttlMs = typeof json.expiresIn === "number" ? json.expiresIn * 1000 : 50 * 60 * 1000;
  saveCache({
    accessToken,
    refreshToken: json.refreshToken ?? refreshToken,
    expiresAt: Date.now() + ttlMs,
  });
  console.log("[auth] refreshed...");
  return accessToken;
}

async function getAccessToken(): Promise<string> {
  return getZetarisToken();
}

export async function zetarisPost(apiPath: string, body: unknown): Promise<Response> {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${BASE_URL}/api/proxy${path}`;

  const post = (token: string) =>
    fetch(url, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

  let token = await getAccessToken();
  let res = await post(token);
  if (res.status === 401) {
    token = await getZetarisToken(true);
    res = await post(token);
  }
  return res;
}

export async function zetarisGet(apiPath: string): Promise<Response> {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${BASE_URL}/api/proxy${path}`;

  const send = (token: string) =>
    fetch(url, {
      method: "GET",
      headers: authHeaders(token),
    });

  let token = await getAccessToken();
  let res = await send(token);
  if (res.status === 401) {
    token = await getZetarisToken(true);
    res = await send(token);
  }
  return res;
}
