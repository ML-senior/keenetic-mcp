import { ValidationError } from '../router/errors.js';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/** True for a MAC in any case, with `:` or `-` separators. */
export function isMac(value: string): boolean {
  return MAC_RE.test(value.trim().toLowerCase().replace(/-/g, ':'));
}

/**
 * The form the router stores and compares: lowercase, colon-separated.
 *
 * Every write that names a device goes through here. The router matches MACs
 * as strings, so an uppercase or dash-separated one is accepted, changes
 * nothing, and is then reported as a write that "did not take effect".
 */
export function normMac(value: string): string {
  const mac = value.trim().toLowerCase().replace(/-/g, ':');
  if (!MAC_RE.test(mac)) {
    throw new ValidationError(`'${value}' is not a MAC address (expected aa:bb:cc:dd:ee:ff).`);
  }
  return mac;
}

/** Dotted-quad IPv4 with every octet in range - `999.1.1.1` is not an address. */
export function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export function checkIPv4(value: string): string {
  if (!isIPv4(value)) throw new ValidationError(`'${value}' is not an IPv4 address.`);
  return value;
}

export function normDomain(value: string): string {
  const domain = value.trim().replace(/\.$/, '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    throw new ValidationError(`'${value}' is not a valid domain name.`);
  }
  return domain;
}

export function checkPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError(`port ${String(value)} is out of range (1-65535).`);
  }
  return value;
}
