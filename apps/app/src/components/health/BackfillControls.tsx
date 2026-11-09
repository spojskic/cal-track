import { View } from 'react-native';

import { TextField } from '@/components/forms';
import { Button } from '@/components/ui';
import { spacing } from '@/theme';

import type { BackfillValidation } from './format';

/** Backfill start date (YYYY-MM-DD) and the button that re-imports everything from that day. */
export function BackfillControls({
  value,
  onChange,
  validation,
  hint,
  onBackfill,
  busy,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  validation: BackfillValidation;
  hint?: string;
  /** Omit to show only the date field (before connecting). */
  onBackfill?: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      <TextField
        label="Backfill from"
        value={value}
        onChangeText={onChange}
        placeholder="YYYY-MM-DD"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        error={value.length > 0 ? validation.error : null}
        hint={hint}
      />
      {onBackfill ? (
        <Button
          label="Backfill"
          variant="secondary"
          onPress={onBackfill}
          loading={busy}
          disabled={disabled || validation.value === null}
        />
      ) : null}
    </View>
  );
}
