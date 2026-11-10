// The thin status bar along the bottom of the desktop window: when the data last synced at the left; the AI status, the colour theme and
// the app version at the right. The texts are built in status-text.ts. Nothing here starts a sync or polls: it reads the sync state
// the app already keeps (the in-memory sync stores for "Syncing...", the `integrations` rows through the same query hooks the
// Connected apps & devices screen uses for the time of the last finished sync).
import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAiGate } from '@/ai/use-ai-gate';
import { useIntegration } from '@/data/health';
import { useGarminSyncStore } from '@/health/garmin-status';
import { useHealthSyncStore } from '@/health/status';
import { getPalette, useTheme, withAlpha } from '@/theme';
import { STATUS_BAR_HEIGHT } from '@/theme/desktop';

import { STATUS_SEPARATOR, buildStatusRight, formatSyncStatus, newestDate } from './status-text';

/** How often "5 min ago" is recomputed. */
const TICK_MS = 30_000;

/** The current time, refreshed every half minute so a relative text ("12 min ago") keeps up. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** When the newest connected source (Apple Health, Health Connect or Garmin) last finished a sync; null when none has. */
function useLastSyncAt(): Date | null {
  const apple = useIntegration('apple_health').data;
  const healthConnect = useIntegration('health_connect').data;
  const garmin = useIntegration('garmin').data;
  return useMemo(
    () => newestDate([apple, healthConnect, garmin].map((row) => (row?.enabled && row.last_sync_at ? new Date(row.last_sync_at) : null))),
    [apple, healthConnect, garmin],
  );
}

export function ShellStatusBar() {
  const { colors, paletteId } = useTheme();
  const insets = useSafeAreaInsets();
  const ai = useAiGate();
  const now = useNow();
  const lastSyncAt = useLastSyncAt();
  const healthRunning = useHealthSyncStore((s) => s.running);
  const garminRunning = useGarminSyncStore((s) => s.running);

  const left = formatSyncStatus({ syncing: healthRunning || garminRunning, lastSyncAt, now });
  const right = buildStatusRight({
    aiEnabled: ai.enabled,
    paletteName: getPalette(paletteId)?.name,
    version: Constants.expoConfig?.version,
  });

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: colors.sidebar,
          borderTopColor: withAlpha(colors.onSidebar, 0.12),
          height: STATUS_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
        },
      ]}>
      <Text numberOfLines={1} style={[styles.text, styles.left, { color: colors.onSidebarMuted }]}>
        {left}
      </Text>
      <View style={styles.right}>
        {right.map((item, i) => (
          <View key={item} style={styles.item}>
            {i > 0 ? <Text style={[styles.text, { color: colors.onSidebarMuted }]}>{STATUS_SEPARATOR}</Text> : null}
            <Text numberOfLines={1} style={[styles.text, { color: colors.onSidebarMuted }]}>
              {item}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 11.5 },
  left: { flexShrink: 1, minWidth: 0 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
