import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isIP, isIPv6 } from "node:net";
import path from "node:path";
import type { ConsoleConfig } from "./config.js";

/** Where docs/lan.md has `tailscale cert` write the pair, so a bare `login-link` finds it. */
const TLS_DIR = "tls";

/**
 * The host a login link names: the first LAN name the certificate covers, else the first name
 * on the certificate, else the bound address when the certificate covers it. A name the
 * certificate does not cover would open on a TLS warning, so none is ever chosen.
 */
export function linkHost(config: ConsoleConfig): string {
  const certFile = lanCertFile(config);
  const cert = readCert(certFile);
  const covers = (name: string): boolean => cert.checkHost(name, { wildcards: true, subject: "default" }) !== undefined;
  const host = config.lanNames.find(covers) ?? certDnsNames(cert).find(covers) ?? boundAddress(config, cert);
  if (host === null) throw new Error(`The certificate ${certFile} covers none of TITAN_CONSOLE_LAN_NAMES (${config.lanNames.join(", ")}) and names no host to link to`);
  return host;
}

function lanCertFile(config: ConsoleConfig): string {
  if (config.lanTls) return config.lanTls.certFile;
  const dir = path.join(config.stateDir, TLS_DIR);
  const found = listCerts(dir);
  if (found.length !== 1) throw new Error(`Set TITAN_CONSOLE_TLS_CERT: a login link names a host the certificate covers, and ${dir} holds ${found.length} .crt files, not one`);
  return path.join(dir, found[0]!);
}

function listCerts(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".crt"));
  } catch {
    return [];
  }
}

function readCert(certFile: string): X509Certificate {
  try {
    return new X509Certificate(readFileSync(certFile));
  } catch (error) {
    throw new Error(`Cannot read the LAN certificate ${certFile}`, { cause: error });
  }
}

/** Wildcard entries name no host a browser can dial, so they are left out. */
function certDnsNames(cert: X509Certificate): string[] {
  const entries = (cert.subjectAltName ?? "").split(",").map((entry) => entry.trim());
  return entries.filter((entry) => entry.startsWith("DNS:")).map((entry) => entry.slice(4).toLowerCase()).filter((name) => !name.includes("*"));
}

function boundAddress(config: ConsoleConfig, cert: X509Certificate): string | null {
  const address = config.lanHost;
  if (!address || isIP(address) === 0 || cert.checkIP(address) === undefined) return null;
  return isIPv6(address) ? `[${address}]` : address;
}
