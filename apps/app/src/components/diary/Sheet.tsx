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
import { WIDE_BREAKPOINT, radius, spacing, useTheme } from '@/theme';

import { IconButton } from './IconButton';

/**
 * Presents `fn` after the current modal finished closing. Two native modals cannot be swapped in the same tick
 * on iOS, so menus use this to open a follow-up sheet.
 */
export function runAfterModal(fn: () => void): void {
  setTimeout(fn, Platform.OS === 'ios' ? 380 : 60);
}

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
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE_BREAKPOINT;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.overlay, wide ? styles.overlayCenter : styles.overlayBottom]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.scrim]}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            wide ? styles.sheetWide : styles.sheetPhone,
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
  const { colors } = useTheme();
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
            style={({ pressed }) => [styles.menuItem, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}>
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
  scrim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderWidth: StyleSheet.hairlineWidth },
  sheetPhone: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
  },
  sheetWide: { width: 520, maxWidth: '92%', borderRadius: radius.lg, paddingTop: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  headerText: { flex: 1, gap: 2 },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md },
  menu: { gap: 2 },
  menuItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md },
});
