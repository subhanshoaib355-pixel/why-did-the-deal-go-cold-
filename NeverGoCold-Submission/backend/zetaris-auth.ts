import { execFileSync } from "node:child_process";

const BASE_URL = (process.env.ZETARIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RENEW_WITHIN_MS = 60_000;

type EnvName = "ZETARIS_EMAIL" | "ZETARIS_PASSWORD" | "ZETARIS_TOKEN";

type MemoryToken = {
  token: string;
  expMs: number;
};

type LoginResponse = {
  idToken?: unknown;
  msg?: unknown;
};

let memory: MemoryToken | null = null;
let pending: Promise<string> | null = null;

function parseRegValue(output: string, name: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const expandAt = line.indexOf("REG_EXPAND_SZ");
    const szAt = expandAt >= 0 ? -1 : line.indexOf("REG_SZ");
    const at = expandAt >= 0 ? expandAt : szAt;
    if (at < 0) continue;
    const typeLen = expandAt >= 0 ? "REG_EXPAND_SZ".length : "REG_SZ".length;
    if (line.slice(0, at).trim() !== name) continue;
    return line.slice(at + typeLen).replace(/^\s+/, "");
  }
  return null;
}

function readUserScopeFromReg(name: EnvName): string | null {
  const out = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  return parseRegValue(out, name);
}

function readUserScopeFromPowerShell(name: EnvName): string {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${name}','User')`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }
  );
  return out.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

function readUserScope(name: EnvName): string {
  if (process.platform !== "win32") return "";
  try {
    const fromReg = readUserScopeFromReg(name);
    if (fromReg != null) return fromReg;
  } catch {
    // reg failed; PowerShell is the fallback.
  }
  try {
    return readUserScopeFromPowerShell(name);
  } catch {
    return "";
  }
}

function readEnv(name: EnvName): string {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  return readUserScope(name);
}

function jwtExpMs(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    let payload = part.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function tokenIsUsable(token: string): boolean {
  const expMs = jwtExpMs(token);
  if (expMs == null) return true;
  return expMs - Date.now() > RENEW_WITHIN_MS;
}

function fallbackToken(): string {
  const fromProcess = process.env.ZETARIS_TOKEN;
  if (typeof fromProcess === "string" && fromProcess.length > 0 && tokenIsUsable(fromProcess)) {
    return fromProcess;
  }
  const fromUser = readUserScope("ZETARIS_TOKEN");
  if (fromUser && tokenIsUsable(fromUser)) return fromUser;
  if ((typeof fromProcess === "string" && fromProcess.length > 0) || fromUser) {
    throw new Error(
      "ZETARIS_TOKEN is expired or expires within 60 seconds, and ZETARIS_EMAIL and ZETARIS_PASSWORD are not set."
    );
  }
  throw new Error("Set ZETARIS_EMAIL and ZETARIS_PASSWORD, or set ZETARIS_TOKEN.");
}

async function login(email: string, password: string): Promise<string> {
  const url = `${BASE_URL}/api/auth/login`;
  if (!url.startsWith("http")) {
    throw new Error("ZETARIS_BASE_URL is not a valid login URL.");
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email, password }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "network error";
    throw new Error(`zetaris login request failed: ${detail}`);
  }
  const text = await res.text();
  let json: LoginResponse | null = null;
  try {
    json = JSON.parse(text) as LoginResponse;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json && typeof json.msg === "string" ? json.msg : "";
    const safe = msg && msg.length < 200 && !msg.includes(password) && !msg.includes(email) ? ` ${msg}` : "";
    throw new Error(`zetaris login failed: HTTP ${res.status}${safe}`);
  }
  const idToken = json && typeof json.idToken === "string" ? json.idToken : "";
  if (!idToken) {
    throw new Error("zetaris login response did not include idToken.");
  }
  return idToken;
}

async function acquire(): Promise<string> {
  const email = readEnv("ZETARIS_EMAIL");
  const password = readEnv("ZETARIS_PASSWORD");
  if (email && password) return login(email, password);
  if (email || password) {
    throw new Error("Set both ZETARIS_EMAIL and ZETARIS_PASSWORD, or set ZETARIS_TOKEN.");
  }
  return fallbackToken();
}

export async function getZetarisToken(force = false): Promise<string> {
  if (!force && memory && memory.expMs - Date.now() > RENEW_WITHIN_MS) {
    return memory.token;
  }
  if (!force && pending) return pending;
  const run = (async () => {
    const token = await acquire();
    const expMs = jwtExpMs(token);
    memory = { token, expMs: expMs ?? Date.now() + 14 * 60_000 };
    return token;
  })();
  pending = run;
  try {
    return await run;
  } catch (e) {
    if (force) memory = null;
    throw e;
  } finally {
    if (pending === run) pending = null;
  }
}
