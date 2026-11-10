import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui';
import { WIDE_BREAKPOINT, spacing, useTheme, withAlpha } from '@/theme';

import { IconButton } from './IconButton';

/**
 * Presents `fn` after the current modal finished closing. Two native modals cannot be swapped in the same tick
 * on iOS, so menus use this to open a follow-up sheet.
 */
export function runAfterModal(fn: () => void): void {
  setTimeout(fn, Platform.OS === 'ios' ? 380 : 60);
}

/** How strongly the sheet dims the screen behind it (the colour is the palette's `scrim`). */
const SCRIM_OPACITY = 0.45;

/** Bottom sheet on phones, centred dialog on wide screens. */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { colors, radius } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE_BREAKPOINT;

  // react-native-web's Modal only becomes active (Escape closes it, focus is trapped) once its fade-in animation
  // ended, and it keeps a click-blocking layer while it fades out. On the web the sheet therefore appears and
  // disappears at once, so Escape works immediately and the page is usable the moment the sheet is closed.
  const animationType = Platform.OS === 'web' ? 'none' : 'fade';

  return (
    <Modal visible={visible} transparent animationType={animationType} onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.overlay, wide ? styles.overlayCenter : styles.overlayBottom]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.scrim, SCRIM_OPACITY) }]}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            wide ? styles.sheetWide : styles.sheetPhone,
            wide ? { borderRadius: radius.lg } : { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              maxHeight: height * 0.88,
              paddingBottom: wide ? spacing.lg : Math.max(insets.bottom, spacing.lg),
            },
          ]}>
          {title ? (
            <View style={styles.header}>
              <View style={styles.headerText}>
                <AppText variant="heading" numberOfLines={2}>
                  {title}
                </AppText>
                {subtitle ? (
                  <AppText variant="small" muted numberOfLines={1}>
                    {subtitle}
                  </AppText>
                ) : null}
              </View>
              <IconButton glyph="×" label="Close" onPress={onClose} size={36} />
            </View>
          ) : null}
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface MenuAction {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/** Simple action list in a sheet. The chosen action runs after the menu closed. */
export function ActionMenu({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title?: string;
  actions: MenuAction[];
  onClose: () => void;
}) {
  const { colors, radius } = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={styles.menu}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              runAfterModal(action.onPress);
            }}
            style={({ pressed }) => [
              styles.menuItem,
              { backgroundColor: pressed ? colors.surfaceAlt : 'transparent', borderRadius: radius.md },
            ]}>
            <AppText style={{ fontWeight: '600', color: action.destructive ? colors.danger : colors.text }}>
              {action.label}
            </AppText>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  overlayCenter: { justifyContent: 'center', alignItems: 'center' },
  overlayBottom: { justifyContent: 'flex-end' },
  sheet: { borderWidth: StyleSheet.hairlineWidth },
  sheetPhone: { paddingTop: spacing.sm },
  sheetWide: { width: 520, maxWidth: '92%', paddingTop: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  headerText: { flex: 1, gap: 2 },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md },
  menu: { gap: 2 },
  menuItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md },
});
