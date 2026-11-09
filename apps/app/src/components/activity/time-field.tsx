import { Pressable, StyleSheet, View } from 'react-native';

import { TextField } from '@/components/forms';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

export interface TimeOfDay {
  hours: number;
  minutes: number;
}

/** Parses "7:30", "07:30", "19.30", "730", "7pm", "7:30 AM". Returns null when invalid. */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3]?.toLowerCase();
  if (minutes > 59) return null;
  if (suffix) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (suffix === 'pm' ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
}

export function formatTimeOfDay(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local Date for a YYYY-MM-DD date and a time of day. */
export function combineDateAndTime(isoDate: string, t: TimeOfDay): Date {
  const [y, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, t.hours, t.minutes, 0, 0);
}

/** Optional time-of-day text input (no native picker dependency) with a "use current time" shortcut. */
export function TimeField({
  label = 'Time (optional)',
  value,
  onChange,
  hint = '24-hour, e.g. 07:30. Leave empty to skip.',
}: {
  label?: string;
  value: string;
  onChange: (text: string) => void;
  hint?: string;
}) {
  const { colors } = useTheme();
  const invalid = value.trim() !== '' && parseTimeOfDay(value) === null;
  return (
    <View style={styles.wrap}>
      <TextField
        label={label}
        value={value}
        onChangeText={onChange}
        placeholder="HH:MM"
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={8}
        hint={hint}
        error={invalid ? 'Enter a time like 07:30 or 7:30 pm' : null}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use current time"
        onPress={() => onChange(formatTimeOfDay(new Date()))}
        hitSlop={8}
        style={styles.now}>
        <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>
          Use current time
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  now: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
});
