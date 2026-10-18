export interface DeviceSummary {
  mac: string;
  ip: string;
  name: string;
  connection: string;
  rssi: number | null;
  active: boolean;
  rxBytes: number;
  txBytes: number;
  blocked: boolean;
}

export interface InterfaceSummary {
  id: string;
  type: string;
  description: string;
  link: string;
  state: string;
  address: string;
  defaultGateway: boolean;
  /** Physical ports only: the switch-side name and what the port is wired as. */
  port?: {
    rciName: string;
    role: 'wan' | 'lan';
    speedMbps: number | null;
    duplex: string | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/**
 * Nine fields out of roughly forty. The raw hotspot listing is 10.7 KB for nine
 * hosts; almost all of it is noise for "who is on my network".
 *
 * No band label here: deriving 2.4 vs 5 GHz from the WifiMaster index is a
 * guess that breaks on tri-band hardware. get_wifi_status reports bands
 * properly because it already holds the interface records.
 */
export function projectDevice(host: unknown): DeviceSummary {
  const h = asRecord(host);
  const iface = asRecord(h['interface']);
  const ssid = str(h, 'ssid');
  const ifaceLabel = str(iface, 'name') || str(iface, 'id');
  const rssiRaw = h['rssi'];

  return {
    mac: str(h, 'mac'),
    ip: str(h, 'ip'),
    name: str(h, 'name') || str(h, 'hostname') || str(h, 'mac'),
    connection: ssid ? `wifi:${ssid}` : `wired:${ifaceLabel}`,
    rssi: typeof rssiRaw === 'number' ? rssiRaw : null,
    active: bool(h, 'active'),
    rxBytes: num(h, 'rxbytes'),
    txBytes: num(h, 'txbytes'),
    blocked: str(h, 'access') === 'deny'
  };
}

/**
 * Physical ports come back keyed by their label ("0".."4") with an empty
 * `state` and no description; the useful part is in `id` (the switch-side
 * name) and the link fields. The WAN port sits on its own switch,
 * GigabitEthernet1, which is why its label is 0 while LAN ports count from 1.
 */
function projectPort(i: Record<string, unknown>): NonNullable<InterfaceSummary['port']> {
  const rciName = str(i, 'id');
  const speed = Number(i['speed']);
  return {
    rciName,
    role: rciName.startsWith('GigabitEthernet0/') ? 'lan' : 'wan',
    speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
    duplex: str(i, 'duplex') || null
  };
}

export function projectInterface(id: string, iface: unknown): InterfaceSummary {
  const i = asRecord(iface);
  const type = str(i, 'type');
  const summary: InterfaceSummary = {
    id,
    type,
    description: str(i, 'description'),
    link: str(i, 'link'),
    // A port has no administrative state of its own; its link is the answer.
    state: str(i, 'state') || (type === 'Port' ? str(i, 'link') : ''),
    address: str(i, 'address'),
    defaultGateway: bool(i, 'defaultgw')
  };
  if (type === 'Port') {
    const port = projectPort(i);
    summary.port = port;
    if (!summary.description) {
      summary.description = port.role === 'wan' ? 'WAN port' : `LAN port ${str(i, 'label') || id}`;
    }
  }
  return summary;
}
