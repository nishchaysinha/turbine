import AsyncStorage from '@react-native-async-storage/async-storage';

/** A desktop this phone has paired with before (Orca-style host list). */
export interface SavedHost {
  pairingCode: string;
  signalingUrl: string;
  label: string;
  lastConnectedAt: number;
}

const KEY = 'turbine.savedHosts.v1';
const MAX_HOSTS = 8;

export async function loadSavedHosts(): Promise<SavedHost[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(KEY)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((h) => h && typeof h.pairingCode === 'string') : [];
  } catch {
    return [];
  }
}

export function upsertHost(hosts: SavedHost[], host: SavedHost): SavedHost[] {
  const rest = hosts.filter((h) => !(h.pairingCode === host.pairingCode && h.signalingUrl === host.signalingUrl));
  return [host, ...rest].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).slice(0, MAX_HOSTS);
}

export async function rememberHost(host: SavedHost): Promise<SavedHost[]> {
  const next = upsertHost(await loadSavedHosts(), host);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export async function forgetHost(pairingCode: string, signalingUrl: string): Promise<SavedHost[]> {
  const next = (await loadSavedHosts()).filter(
    (h) => !(h.pairingCode === pairingCode && h.signalingUrl === signalingUrl)
  );
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}
