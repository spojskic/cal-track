import { SymbolView } from 'expo-symbols';
import type { RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type TextInputInstance } from 'react-native';

import { spacing, useTheme } from '@/theme';

import { clearsOnKey } from './food-search';

/**
 * Where a search field sits. `screen` is the big field at the top of a phone screen (the Add food screen, the Foods tab); `panel`
 * is the compact one in the toolbar of a desktop panel (the Food library). Corners come from the theme: a pill, or a small radius in a panel.
 */
export type SearchFieldVariant = 'screen' | 'panel';

const SIZES = {
  screen: { height: 46, input: 44, paddingX: spacing.md, gap: spacing.sm, border: StyleSheet.hairlineWidth, icon: 18, font: 16, scan: 46, scanIcon: 24 },
  panel: { height: 36, input: 34, paddingX: 12, gap: 8, border: 1, icon: 16, font: 14, scan: 36, scanIcon: 18 },
} as const;

/**
 * The food search field: magnifier, the text input, a spinner while the server is asked and the clear button (named "Clear search")
 * when there is text. Escape empties it on the web.
 */
export function SearchField({
  value,
  onChangeText,
  busy = false,
  autoFocus = false,
  inputRef,
  variant = 'screen',
}: {
  value: string;
  onChangeText: (text: string) => void;
  /** Show a spinner (the search is running). */
  busy?: boolean;
  autoFocus?: boolean;
  /** To focus the field from outside (a button that says "Search foods"). */
  inputRef?: RefObject<TextInputInstance | null>;
  variant?: SearchFieldVariant;
}) {
  const { colors, radius } = useTheme();
  const size = SIZES[variant];
  return (
    // The input must stay a DIRECT child of the bordered box: the web focus colour (lib/web-styles.ts) goes to its parent.
    <View
      style={[
        styles.box,
        {
          backgroundColor: variant === 'panel' ? colors.background : colors.surface,
          borderColor: colors.border,
          borderRadius: variant === 'panel' ? radius.md : radius.pill,
          borderWidth: size.border,
          minHeight: size.height,
          paddingHorizontal: size.paddingX,
          gap: size.gap,
        },
      ]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={size.icon} tintColor={colors.textMuted} />
      <TextInput
        ref={inputRef}
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        onKeyPress={(e) => {
          if (clearsOnKey(e.nativeEvent.key, value)) onChangeText('');
        }}
        placeholder="Search foods, e.g. banana or rice"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Search foods"
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: colors.text, fontSize: size.font, minHeight: size.input }]}
      />
      {busy ? <ActivityIndicator color={colors.textMuted} style={styles.spinner} accessibilityLabel="Searching" /> : null}
      {value.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChangeText('')} hitSlop={8} style={styles.clear}>
          <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }} size={size.icon} tintColor={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The square button next to a search field that opens the barcode scanner. */
export function ScanButton({ onPress, variant = 'screen' }: { onPress: () => void; variant?: SearchFieldVariant }) {
  const { colors, radius } = useTheme();
  const size = SIZES[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Scan barcode"
      onPress={onPress}
      style={({ pressed }) => [
        styles.scan,
        {
          width: size.scan,
          height: size.scan,
          backgroundColor: variant === 'panel' ? colors.background : colors.surface,
          borderColor: colors.border,
          borderRadius: variant === 'panel' ? radius.md : radius.pill,
          borderWidth: size.border,
        },
        pressed && { opacity: 0.7 },
      ]}>
      <SymbolView
        name={{ ios: 'barcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' }}
        size={size.scanIcon}
        tintColor={colors.text}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1 },
  spinner: { marginLeft: spacing.xs },
  clear: { padding: spacing.xs },
  scan: { alignItems: 'center', justifyContent: 'center' },
});
