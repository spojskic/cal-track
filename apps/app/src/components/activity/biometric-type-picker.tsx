import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing } from '@/theme';

import { BIOMETRIC_KINDS, type BiometricKind } from './biometric-types';
import { Chip } from './chips';

/** Wrapping single-select chips for choosing what to record. */
export function BiometricTypePicker({
  value,
  onChange,
}: {
  value: BiometricKind;
  onChange: (kind: BiometricKind) => void;
}) {
  return (
    <View style={styles.group}>
      <AppText variant="label" muted>Type</AppText>
      <View style={styles.row}>
        {BIOMETRIC_KINDS.map((k) => (
          <Chip key={k.kind} label={k.label} selected={k.kind === value} onPress={() => onChange(k.kind)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
