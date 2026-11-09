import { ActivityIndicator, View } from 'react-native';

import { Note } from '@/components/settings/rows';
import { AppText } from '@/components/ui';
import { useHealthSyncStatus } from '@/data/health';
import { spacing, useTheme } from '@/theme';

import { formatProgress } from './format';

/** Progress of a running sync, then its result (summary, per-type issues) and any fatal error. */
export function SyncStatusPanel({ providerLabel }: { providerLabel: string }) {
  const { colors } = useTheme();
  const status = useHealthSyncStatus();

  return (
    <View style={{ gap: spacing.sm }} accessibilityLiveRegion="polite">
      {status.running ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <ActivityIndicator color={colors.primary} accessibilityLabel={`Syncing ${providerLabel}`} />
          <AppText variant="small" muted style={{ flex: 1 }}>
            {status.progress ? formatProgress(status.progress) : `Syncing ${providerLabel}...`}
          </AppText>
        </View>
      ) : null}

      {!status.running && status.lastError ? <Note tone="danger">{status.lastError}</Note> : null}

      {!status.running && status.lastResult && !status.lastError ? (
        <Note tone={status.lastResult.ok ? 'success' : 'warning'}>
          {`Synced: ${status.lastResult.summary}.`}
        </Note>
      ) : null}

      {!status.running
        ? status.lastResult?.issues.map((issue, i) => (
            <Note key={`${issue.scope}-${i}`} tone="warning">
              {`${issue.scope === 'general' ? 'Sync' : issue.scope.replace(/_/g, ' ')}: ${issue.message}`}
            </Note>
          ))
        : null}

      {!status.running ? status.lastWarnings.map((w, i) => <Note key={`w-${i}`}>{w}</Note>) : null}
    </View>
  );
}
