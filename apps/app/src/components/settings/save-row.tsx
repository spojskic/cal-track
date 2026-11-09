import { View } from 'react-native';

import { AppText, Button } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { Note } from './rows';

/** Best-effort message from an Error, a Supabase/PostgREST error object or anything else. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Something went wrong. Please try again.';
}

/** Save button with inline "Saved" confirmation and the last error. */
export function SaveRow({
  label = 'Save',
  onPress,
  dirty,
  valid = true,
  loading,
  saved,
  error,
}: {
  label?: string;
  onPress: () => void;
  /** There are unsaved changes. */
  dirty: boolean;
  /** The draft can be saved. */
  valid?: boolean;
  loading?: boolean;
  /** The last save succeeded. */
  saved?: boolean;
  error?: unknown;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <Button label={label} onPress={onPress} loading={loading} disabled={!dirty || !valid} />
      {saved && !dirty && !error ? (
        <AppText variant="small" style={{ color: colors.success, textAlign: 'center' }} accessibilityLiveRegion="polite">
          Saved
        </AppText>
      ) : null}
      {error ? <Note tone="danger">{errorMessage(error)}</Note> : null}
    </View>
  );
}
