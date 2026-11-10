import { asRecord, bool, num, numOrNull, str } from './coerce.js';

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
  /** Seconds since the router last heard from it; null when it does not say. */
  lastSeenSec: number | null;
  /** Present only for a client hanging off a Mesh extender rather than the controller. */
  viaExtender?: true;
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

/**
 * Ten fields out of roughly forty. The raw hotspot listing is 10.7 KB for nine
 * hosts; almost all of it is noise for "who is on my network".
 *
 * No band label here: deriving 2.4 vs 5 GHz from the WifiMaster index is a
 * guess that breaks on tri-band hardware. get_wifi_status reports bands
 * properly because it already holds the interface records.
 */
export function projectDevice(host: unknown): DeviceSummary {
  const h = asRecord(host);
  const iface = asRecord(h['interface']);
  // A client associated with a Mesh extender carries its radio details one
  // level down, under `mws`, and nothing at the top level (measured on a
  // KN-1810 with a KN-3810 extender, KeeneticOS 5.2). Reading only the top
  // level reported every such client as wired, with no signal strength.
  const mesh = asRecord(h['mws']);
  const viaExtender = typeof mesh['ssid'] === 'string' && mesh['ssid'] !== '';
  const radio = str(h, 'ssid') ? h : mesh;
  const ssid = str(radio, 'ssid');
  const ifaceLabel = str(iface, 'name') || str(iface, 'id');
  const rssiRaw = radio['rssi'];

  const summary: DeviceSummary = {
    mac: str(h, 'mac'),
    ip: str(h, 'ip'),
    name: str(h, 'name') || str(h, 'hostname') || str(h, 'mac'),
    connection: ssid ? `wifi:${ssid}` : `wired:${ifaceLabel}`,
    rssi: typeof rssiRaw === 'number' ? rssiRaw : null,
    active: bool(h, 'active'),
    rxBytes: num(h, 'rxbytes'),
    txBytes: num(h, 'txbytes'),
    blocked: str(h, 'access') === 'deny',
    lastSeenSec: numOrNull(h['last-seen'])
  };
  if (viaExtender && !str(h, 'ssid')) summary.viaExtender = true;
  return summary;
}

/**
 * Physical ports come back keyed by their label ("0".."4") with an empty
 * `state` and no description; the useful part is in `id` (the switch-side
 * name) and the link fields. The WAN port sits on its own switch,
 * GigabitEthernet1, which is why its label is 0 while LAN ports count from 1.
 */
function projectPort(i: Record<string, unknown>): NonNullable<InterfaceSummary['port']> {
  const rciName = str(i, 'id');
  const speed = numOrNull(i['speed']) ?? Number.NaN;
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
