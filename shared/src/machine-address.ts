/**
 * Adresse der Xenia im LAN, wie sie in den Einstellungen steht: IPv4 oder
 * Hostname, optional mit Port (der Mock laeuft auf `localhost:3099`). Ohne
 * Schema und ohne Pfad — der Client setzt `http://` davor.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Normalisierte Adresse (getrimmt, Hostname klein) oder null, wenn ungueltig. */
export function normalizeMachineAddress(raw: string): string | null {
  const s = raw.trim();
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const [, host, port] = m;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  // Rein numerisch, aber kein gueltiges IPv4 (z. B. 192.168.1.300) ist ein Tippfehler,
  // kein Hostname.
  const numeric = /^[\d.]+$/.test(host);
  if (numeric ? !IPV4.test(host) : !HOSTNAME.test(host)) return null;
  const h = numeric ? host : host.toLowerCase();
  return port !== undefined ? `${h}:${Number(port)}` : h;
}
