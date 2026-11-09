import { KeyValueRow } from '@/components/settings/rows';
import { useLastSyncInfo } from '@/data/health';
import { PROVIDER_LABELS } from '@/health/settings';
import type { HealthProviderId } from '@/health/types';

import { formatRelativeTime } from './format';

/** Read-only connection state of a provider (used on the web, where syncing cannot run). */
export function ConnectionSummary({ providerId }: { providerId: HealthProviderId }) {
  const info = useLastSyncInfo(providerId);
  const label = PROVIDER_LABELS[providerId];
  const value = !info.connected
    ? 'Not connected'
    : info.lastSyncAt
      ? `Synced ${formatRelativeTime(info.lastSyncAt)}`
      : 'Connected';
  return <KeyValueRow label={label} value={value} hint={info.connected ? (info.summary ?? undefined) : undefined} />;
}
