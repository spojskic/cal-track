// What "Copy sync report" prints about the workout-detail reads of THIS phone: endpoint outcomes and field names, never a value
// (packages/garmin activity-details.ts DetailStats). Kept on the phone only, like the sync report itself (garmin-local.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { emptyDetailStats, parseDetailStats, type DetailStats } from '@cal/garmin';

const KEY = 'cal-track.garmin.detail-stats';

export async function loadDetailStats(): Promise<DetailStats> {
  try {
    return parseDetailStats(await AsyncStorage.getItem(KEY));
  } catch {
    return emptyDetailStats();
  }
}

export async function saveDetailStats(stats: DetailStats): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(stats));
}

export async function clearDetailStats(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
