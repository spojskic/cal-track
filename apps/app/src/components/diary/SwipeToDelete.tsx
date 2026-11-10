import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/theme';

import { haptic } from './haptics';
import { isFullSwipe } from './swipe-delete';

export interface SwipeToDeleteProps {
  /** Accessible name of the red action, e.g. "Delete Oats, rolled, dry". */
  label: string;
  onDelete: () => void;
  children: ReactNode;
}

/** Width of the red action when the row rests open. */
const ACTION_WIDTH = 84;

/** The row that is open right now (only one row is open at a time). */
let openRow: SwipeableMethods | null = null;

/**
 * Swipe a row to the left to reveal a red, full-height delete action; swipe it past ~60 % of its width and let go
 * to delete at once. Opening a row closes the one that was open. The row's own content must not have a transparent
 * background (the action sits underneath it) - the container paints the page background.
 *
 * Native only: the web build uses SwipeToDelete.web.tsx (a plain pass-through), the entry sheet deletes there.
 */
export function SwipeToDelete({ label, onDelete, children }: SwipeToDeleteProps) {
  const { colors } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  // Set from the UI thread while dragging (see DeleteAction); read when the finger lets go.
  const armed = useRef(false);
  const rowWidth = useSharedValue(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const methods = swipeable.current;
    return () => {
      if (methods !== null && openRow === methods) openRow = null;
    };
  }, []);

  const onArmedChange = useCallback((next: boolean) => {
    armed.current = next;
    if (next) haptic('selection');
  }, []);

  const closeOthers = () => {
    if (openRow !== null && openRow !== swipeable.current) {
      openRow.close();
      openRow = null;
    }
  };

  return (
    <View onLayout={(e) => rowWidth.set(e.nativeEvent.layout.width)}>
      <ReanimatedSwipeable
        ref={swipeable}
        rightThreshold={ACTION_WIDTH / 2}
        dragOffsetFromRight={-12}
        childrenContainerStyle={{ backgroundColor: colors.background }}
        onSwipeableOpenStartDrag={closeOthers}
        onSwipeableWillOpen={() => {
          if (armed.current) {
            // Let go past the full-swipe line: delete (the row disappears with the list update).
            armed.current = false;
            onDelete();
            return;
          }
          closeOthers();
          openRow = swipeable.current;
        }}
        onSwipeableOpen={() => setOpen(true)}
        onSwipeableClose={() => {
          setOpen(false);
          if (openRow === swipeable.current) openRow = null;
        }}
        renderRightActions={(_progress, translation) => (
          <DeleteAction
            translation={translation}
            rowWidth={rowWidth}
            label={label}
            visibleToReaders={open}
            onArmedChange={onArmedChange}
            onPress={() => {
              swipeable.current?.close();
              onDelete();
            }}
          />
        )}>
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

/**
 * The red action behind the row. It is ACTION_WIDTH wide at rest (the swipeable measures that width) and follows the
 * finger once the row is pulled further, so the red area always reaches the row's edge.
 */
function DeleteAction({
  translation,
  rowWidth,
  label,
  visibleToReaders,
  onArmedChange,
  onPress,
}: {
  translation: SharedValue<number>;
  rowWidth: SharedValue<number>;
  label: string;
  visibleToReaders: boolean;
  onArmedChange: (armed: boolean) => void;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  const areaStyle = useAnimatedStyle(() => ({
    width: Math.max(ACTION_WIDTH, -translation.get()),
    // Invisible at rest so no red hairline shows around the edges of the row.
    opacity: translation.get() < -2 ? 1 : 0,
  }));

  useAnimatedReaction(
    () => isFullSwipe(-translation.get(), rowWidth.get()),
    (armed, previous) => {
      if (armed !== previous) scheduleOnRN(onArmedChange, armed);
    },
  );

  return (
    <Animated.View
      accessibilityElementsHidden={!visibleToReaders}
      importantForAccessibility={visibleToReaders ? 'auto' : 'no-hide-descendants'}
      style={[styles.area, { backgroundColor: colors.danger }, areaStyle]}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.press}>
        <SymbolView
          name={{ ios: 'trash', android: 'delete' }}
          size={22}
          tintColor={colors.onPrimary}
          fallback={<Text style={{ color: colors.onPrimary, fontWeight: '700' }}>Delete</Text>}
        />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  area: { minWidth: ACTION_WIDTH },
  press: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
