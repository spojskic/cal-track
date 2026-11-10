import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAX_CONTENT_WIDTH, radius, spacing, useTheme } from '@/theme';

type TextVariant = 'title' | 'heading' | 'body' | 'small' | 'label';

const textStyles: Record<TextVariant, TextStyle> = {
  title: { fontSize: 28, fontWeight: '800' },
  heading: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 16, fontWeight: '400' },
  small: { fontSize: 13, fontWeight: '400' },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
};

export function AppText({
  variant = 'body',
  muted,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; muted?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      {...rest}
      style={[textStyles[variant], { color: muted ? colors.textMuted : colors.text }, style]}
    />
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        style,
      ]}>
      {children}
    </View>
  );
}

/** Scrollable page with centred max-width content. */
export function Screen({
  children,
  title,
  scroll = true,
  safeTop = false,
}: {
  children: ReactNode;
  title?: string;
  scroll?: boolean;
  /** Keep the content below the status bar / notch. Only for screens WITHOUT a native header (a header does this itself). */
  safeTop?: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const content = (
    <View style={styles.content}>
      {title ? <AppText variant="title" style={styles.pageTitle}>{title}</AppText> : null}
      {children}
    </View>
  );
  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: safeTop ? insets.top : 0 }]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">{content}</ScrollView>
      ) : (
        content
      )}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const bg =
    variant === 'primary' ? colors.primary : variant === 'secondary' ? colors.surfaceAlt : 'transparent';
  const fg = variant === 'primary' ? colors.onPrimary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  pageTitle: { marginTop: spacing.sm },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  button: {
    minHeight: 46,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Centred, so a label that has to wrap (two buttons sharing a row) still sits in the middle of its pill.
  buttonLabel: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
