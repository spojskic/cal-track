import { View } from 'react-native';

import { HEALTH_DATA_TYPES, type HealthDataType } from '@/health/types';
import { DATA_TYPE_INFO, type HealthToggles } from '@/health/settings';
import { spacing } from '@/theme';

import { CheckboxRow } from './Checkbox';

/** One checkbox per importable data type (Cronometer-style "Connected Apps & Devices" list). */
export function DataTypeChecklist({
  toggles,
  onToggle,
  disabled,
}: {
  toggles: HealthToggles;
  onToggle: (type: HealthDataType, value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: spacing.xs }}>
      {HEALTH_DATA_TYPES.map((type) => (
        <CheckboxRow
          key={type}
          label={DATA_TYPE_INFO[type].label}
          description={DATA_TYPE_INFO[type].description}
          checked={toggles[type]}
          disabled={disabled}
          onChange={(value) => onToggle(type, value)}
        />
      ))}
    </View>
  );
}
