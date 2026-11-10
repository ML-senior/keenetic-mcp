# Changelog

Releases are git tags; the version is stamped from the tag at publish time and
is not written down in the sources, so entries here are headed by what changed
rather than by a number until they are tagged.

## Unreleased

### Fixed

- **Clients on a Mesh extender were reported as wired, with no signal.** The
  router nests their radio details under `mws` rather than at the top level.
  `list_devices` now shows them as `wifi:<ssid>` with their RSSI and marks them
  `viaExtender`; the `wired` / `wireless` filters follow.
- **`get_mesh_nodes` credited every extender with all extender clients.**
  Correct with one extender, wrong with two. Clients are now attributed by the
  node id they carry, and each extender also reports its backhaul uplink and
  whether it has internet. When the Mesh subsystem cannot be read and there are
  several extenders, the count is `null` rather than a guess.
- **`list_devices sort=last_seen` did not sort by last seen.** It ordered by
  online/offline only. It now uses the router's `last-seen`, most recent first,
  and each device carries `lastSeenSec`.
- **Response caps were measured in characters, not bytes.** Text in Cyrillic
  or any other multi-byte script could leave at up to twice the configured
  `--max-response-bytes`. The cut is now made in bytes and never through the
  middle of a character.
- **`ssh_write_file` could leave a truncated file behind.** It overwrote the
  target and verified afterwards, and passed the content on the command line,
  which fails outright for large files. The content now travels on stdin, is
  written beside the target, checksum-verified, and only then moved into place;
  on any failure the existing file is untouched. File mode is preserved and
  symlinks are written through rather than replaced.
- **`update_device` accepted a MAC it could not match.** `AA-BB-…` was sent as
  typed, changed nothing, and failed verification with a misleading message.
  MACs are normalized first and anything that is not one is refused up front.
- **`rci_call` was the one write path that took no backup.** A POST that is not
  a pure `show` now snapshots the startup configuration first, like every
  curated write.
- **IPv4 validation accepted `999.1.1.1`.** Octets are now range-checked.
- A dropped SSH connection (router rebooting, dropbear restarting) is reported
  immediately instead of after the full command timeout, and a timed-out
  command no longer leaves its connection open.
- `list_policies` now lists a policy's interface when the router returns a
  single `permit` entry unwrapped.
- Connection errors say why (`ECONNREFUSED`, `EHOSTUNREACH`, timeout) instead
  of only `fetch failed`.
- The body of an expired-session 401 is discarded, so the connection is
  released straight away.

### Added

- **`get_traffic`** - speed history for an interface or one device, read from
  the archive the router keeps for its own graphs (3 min, 1 h, 3 h, 1 day), so
  nothing is sampled or stored here. **`get_bandwidth_now`** ranks the devices
  by what they are moving this moment, in a single batched request.
- **`get_wifi_survey`** - neighbouring networks, per-channel congestion and a
  channel recommendation. A survey takes the radio off its channel and can
  stall its clients, so it runs on one named radio per call and never by
  default.
- **`get_netfilter`** - `show netfilter` parsed into tables, chains and rules:
  a summary, one chain, or a search by port, address, MAC or verdict. The
  router prints no packet counters there, so this is the rule set in force.
- **`list_wireguard_peers`, `set_wireguard_peer`, `remove_wireguard_peer`** -
  peers on an existing WireGuard interface, by public key. Keys are never
  returned. *Written from the vendor's CLI syntax and verified by read-back,
  but not yet exercised on a router that has a WireGuard interface.*
- **`list_mesh_candidates`, `acquire_mesh_node`** - find a new or factory-reset
  Keenetic on the network and adopt it into the Wi-Fi system, which is the
  whole setup for a new node. *Adoption has not been exercised on hardware: no
  candidate was available. The command is the one confirmed on the vendor
  forum.*
- **`mesh_node_rci`** - the API of a Mesh extender itself. It only reaches
  hosts the controller lists as its own nodes, so the router's credentials are
  never offered to an arbitrary address.
- **`list_schedules`** and **`wake_device`** (Wake-on-LAN).
- `get_mesh_nodes` reports each extender's backhaul uplink, CPU load, internet
  reachability and any newer firmware on offer.
- `list_devices` takes `search`: a case-insensitive substring of the name,
  hostname, IP or MAC.
- `get_device` matches names without regard to case, accepts a MAC in any
  notation and a unique partial name, and lists the candidates when several
  devices match instead of returning the first.
- `KEENETIC_TIMEOUT_MS` / `--timeout-ms` set the per-request timeout.
- SSH command output is bounded at 2 MB per stream, with a note when more was
  discarded.

### Changed

- `@modelcontextprotocol/server` 2.0.0 → 2.4.0 and `zod` to 4.6.7, clearing
  every `npm audit` finding. The SDK advisories concern its HTTP transports,
  which this server does not use, but the audit job in CI was failing on them.
- The JSON-coercion and validation helpers that eight modules each carried a
  private copy of now live in `src/shape/coerce.ts` and `src/shape/validate.ts`.
  The copies had drifted: some treated an array as a record, some did not.
- `npm run typecheck` passes again; it had been failing on the NDW4 session
  tests.
- Tests: 361 → 527, including the SSH client against a real in-process SSH
  server and the `ssh_write_file` script under a real shell.
