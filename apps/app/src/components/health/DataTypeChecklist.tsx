import { useState } from 'react';
import { View } from 'react-native';

import { HEALTH_DATA_TYPES, type HealthDataType } from '@/health/types';
import { DATA_TYPE_INFO, type HealthToggles } from '@/health/settings';
import { visibleHealthDataTypes } from '@/components/health/format';
import { Button } from '@/components/ui';
import { spacing } from '@/theme';

import { CheckboxRow } from './Checkbox';

/**
 * One checkbox per importable data type (Cronometer-style "Connected Apps & Devices" list). The list opens with
 * CHECKLIST_INITIAL rows and every tap on "Show more" adds CHECKLIST_MORE more; an enabled type is always
 * visible (see visibleHealthDataTypes), so a ticked checkbox never hides behind the fold.
 */
export function DataTypeChecklist({
  toggles,
  onToggle,
  disabled,
}: {
  toggles: HealthToggles;
  onToggle: (type: HealthDataType, value: boolean) => void;
  disabled?: boolean;
}) {
  const [expandedPages, setExpandedPages] = useState(0);
  const enabled = HEALTH_DATA_TYPES.filter((type) => toggles[type]);
  const visible = visibleHealthDataTypes(HEALTH_DATA_TYPES, enabled, expandedPages);
  const hidden = HEALTH_DATA_TYPES.length - visible.length;

  return (
    <View style={{ gap: spacing.xs }}>
      {visible.map((type) => (
        <CheckboxRow
          key={type}
          label={DATA_TYPE_INFO[type].label}
          description={DATA_TYPE_INFO[type].description}
          checked={toggles[type]}
          disabled={disabled}
          onChange={(value) => onToggle(type, value)}
        />
      ))}
      {hidden > 0 ? (
        <Button
          label={`Show ${hidden} more`}
          variant="ghost"
          onPress={() => setExpandedPages((pages) => pages + 1)}
        />
      ) : null}
    </View>
  );
}
