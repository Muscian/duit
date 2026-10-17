import { getProxyForUrl } from "proxy-from-env";
import { HarnessError } from "../core/types.js";

export type BrowserConnection = {
  mode: "direct" | "proxy";
  source: string;
  proxy?: string;
};
export type BrowserProxy = {
  server: string;
  bypass: string;
  username?: string;
  password?: string;
};
export function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return "[invalid URL]";
  }
}

export function browserConnection(
  url: string,
  explicit?: string,
): { connection: BrowserConnection; proxy?: BrowserProxy } {
  const configured = explicit ?? process.env.DUIT_BROWSER_PROXY;
  const value = configured ?? getProxyForUrl(url);
  const source =
    explicit !== undefined
      ? "option"
      : configured !== undefined
        ? "DUIT_BROWSER_PROXY"
        : "environment";
  if (!value || value === "direct")
    return { connection: { mode: "direct", source } };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HarnessError(
      "INVALID_PROXY",
      'Browser proxy must be a valid URL, or "direct"',
    );
  }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol))
    throw new HarnessError(
      "INVALID_PROXY",
      "Browser proxy must use http, https or socks5",
    );
  const bypass = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(process.env.no_proxy || process.env.NO_PROXY || "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((host) => (host.startsWith(".") ? "*" + host : host)),
  ].join(",");
  const server = `${parsed.protocol}//${parsed.host}`;
  const proxy: BrowserProxy = { server, bypass };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return { connection: { mode: "proxy", source, proxy: server }, proxy };
}
