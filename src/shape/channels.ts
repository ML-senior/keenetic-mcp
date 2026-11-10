/**
 * Channel congestion from a site survey.
 *
 * A neighbouring network costs a channel more the louder it is and the more of
 * the channel it covers. Each neighbour is weighed by how far its signal sits
 * above a -95 dBm floor - a network at -50 counts for a great deal more than
 * one at -88 that is barely decodable - and charged to every 20 MHz channel it
 * occupies. This is a ranking, not a physical model: it is meant to tell a
 * crowded channel from a quiet one, not to predict throughput.
 */
export interface SurveyCell {
  ssid: string;
  bssid: string;
  channel: number;
  /** Every 20 MHz channel the network occupies, as the router reports it. */
  occupied: number[];
  widthMhz: number | null;
  rssi: number;
  /** True for the networks of this very router and its Mesh nodes. */
  own: boolean;
}

export interface ChannelLoad {
  channel: number;
  networks: number;
  /** Relative congestion; only comparable within one survey. */
  score: number;
  dfs?: true;
}

const NOISE_FLOOR_DBM = -95;

export function weightOf(rssi: number): number {
  return Math.max(0, rssi - NOISE_FLOOR_DBM);
}

export function bandOfChannel(channel: number): '2.4GHz' | '5GHz' {
  return channel <= 14 ? '2.4GHz' : '5GHz';
}

/** Radar-shared 5 GHz channels: usable, but the radio must vacate on detection. */
export function isDfs(channel: number): boolean {
  return channel >= 52 && channel <= 144;
}

/**
 * What a network on `channel` at 2.4 GHz spills onto: channels are 5 MHz apart
 * and a 20 MHz signal is four wide, so it reaches two either side.
 */
function footprint24(channel: number): number[] {
  return [-2, -1, 0, 1, 2].map(d => channel + d).filter(c => c >= 1 && c <= 14);
}

/** The channels a neighbour is charged to. */
function occupiedBy(cell: SurveyCell): number[] {
  if (cell.channel <= 14) {
    // The router's list is the span of centre channels; spill is two beyond it.
    const base = cell.occupied.length > 0 ? cell.occupied : [cell.channel];
    const lo = Math.max(1, Math.min(...base) - (cell.occupied.length > 0 ? 0 : 2));
    const hi = Math.min(14, Math.max(...base) + (cell.occupied.length > 0 ? 0 : 2));
    const out: number[] = [];
    for (let c = lo; c <= hi; c += 1) out.push(c);
    return out;
  }
  return cell.occupied.length > 0 ? cell.occupied : [cell.channel];
}

const CHANNELS_24 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const CHANNELS_5 = [
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149,
  153, 157, 161, 165
];

/** Per-channel congestion from the neighbours, ignoring this router's own networks. */
export function channelLoads(cells: readonly SurveyCell[], band: '2.4GHz' | '5GHz'): ChannelLoad[] {
  const channels = band === '2.4GHz' ? CHANNELS_24 : CHANNELS_5;
  const neighbours = cells.filter(c => !c.own && bandOfChannel(c.channel) === band);

  return channels.map(channel => {
    // At 2.4 GHz the question is what a 20 MHz signal centred here would
    // collide with, so the candidate has a footprint too.
    const mine = band === '2.4GHz' ? footprint24(channel) : [channel];
    let score = 0;
    let networks = 0;
    for (const cell of neighbours) {
      const theirs = occupiedBy(cell);
      const overlap = mine.filter(c => theirs.includes(c)).length;
      if (overlap === 0) continue;
      networks += 1;
      score += weightOf(cell.rssi) * (overlap / mine.length);
    }
    const load: ChannelLoad = { channel, networks, score: Math.round(score * 10) / 10 };
    if (isDfs(channel)) load.dfs = true;
    return load;
  });
}

export interface ChannelAdvice {
  recommended: number;
  current: number | null;
  /** True when moving is not worth it. */
  keepCurrent: boolean;
  reason: string;
}

/**
 * The quietest channel a radio could sit on.
 *
 * At 2.4 GHz only 1, 6 and 11 are candidates: they are the three that do not
 * overlap each other, and a network parked between them disturbs two at once.
 * At 5 GHz the candidates are the first channels of each 80 MHz block, scored
 * across the whole block, and a non-DFS block wins a near-tie because a radar
 * hit on a DFS channel takes the network down for a minute.
 */
export function adviseChannel(
  loads: readonly ChannelLoad[],
  band: '2.4GHz' | '5GHz',
  current: number | null
): ChannelAdvice | null {
  const scoreOf = (channel: number): number => loads.find(l => l.channel === channel)?.score ?? 0;

  let candidates: Array<{ channel: number; score: number; dfs: boolean }>;
  if (band === '2.4GHz') {
    candidates = [1, 6, 11].map(channel => ({ channel, score: scoreOf(channel), dfs: false }));
  } else {
    const blocks = [36, 52, 100, 116, 132, 149];
    candidates = blocks.map(first => ({
      channel: first,
      score: [0, 4, 8, 12].reduce((sum, d) => sum + scoreOf(first + d), 0),
      dfs: isDfs(first)
    }));
  }
  if (candidates.length === 0) return null;

  // A DFS block has to be clearly better, not marginally, to be worth it.
  const DFS_PENALTY = 10;
  const ranked = [...candidates].sort(
    (a, b) => a.score + (a.dfs ? DFS_PENALTY : 0) - (b.score + (b.dfs ? DFS_PENALTY : 0))
  );
  const best = ranked[0] as (typeof candidates)[number];

  // Which candidate the radio is effectively on now.
  const currentCandidate =
    current === null
      ? undefined
      : band === '2.4GHz'
        ? // Scored where it actually sits: a radio on 13 is not "on 11".
          (candidates.find(c => c.channel === current) ?? {
            channel: current,
            score: scoreOf(current),
            dfs: false
          })
        : candidates.find(c => current >= c.channel && current <= c.channel + 12);

  const currentScore = currentCandidate?.score ?? null;
  // Changing channel drops every client for a moment; a few points of
  // difference between two surveys is noise, not a reason.
  const keepCurrent =
    currentCandidate !== undefined &&
    currentScore !== null &&
    (currentCandidate.channel === best.channel || currentScore - best.score < 15);

  const describe = (c: { channel: number; score: number; dfs: boolean }): string =>
    `${band === '5GHz' ? `block ${String(c.channel)}-${String(c.channel + 12)}` : `channel ${String(c.channel)}`} ` +
    `(congestion ${String(Math.round(c.score))}${c.dfs ? ', DFS' : ''})`;

  let reason: string;
  if (keepCurrent && currentCandidate) {
    reason =
      currentCandidate.channel === best.channel
        ? `The radio is already on the quietest option, ${describe(best)}.`
        : `${describe(best)} is slightly quieter than the current ${describe(currentCandidate)}, ` +
          'but not by enough to justify disconnecting every client to move.';
  } else {
    reason =
      `Quietest is ${describe(best)}` +
      (currentCandidate ? `, against ${describe(currentCandidate)} now.` : '.') +
      (band === '2.4GHz' && current !== null && ![1, 6, 11].includes(current)
        ? ` The radio is on channel ${String(current)}, between the non-overlapping channels, where it disturbs and is disturbed by two of them at once.`
        : '');
  }
  return { recommended: best.channel, current, keepCurrent, reason };
}
