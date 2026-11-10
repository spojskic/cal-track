// The foods screen on a wide window: the library (search field, filter chips and the list, scrolling on its own) in a panel at the left, and a
// narrow column at the right with the create actions and a few lines of help. Typing in the search field puts the results in the same
// list area (the chips step aside while searching). Phones keep the single list of foods.tsx.
import type { ReactNode, RefObject } from 'react';
import { Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import { ScanButton, SearchField } from '@/components/food/search-field';
import { DesktopPage, Panel, ToolbarButton, useAvailableWidth } from '@/components/panel';
import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';

/** The side column (create actions, help) needs this much content width next to the list; below it the actions move to the page header. */
const SIDE_MIN_CONTENT_WIDTH = 760;
const SIDE_WIDTH = 300;

export function FoodsDesktop<T extends string>({
  tabs,
  tab,
  onTab,
  meta,
  list,
  query,
  onQuery,
  searching,
  searchBusy,
  searchInputRef,
  onScan,
  onCreateFood,
  onCreateRecipe,
  onNewSavedMeal,
}: {
  tabs: { value: T; label: string }[];
  tab: T;
  onTab: (tab: T) => void;
  /** "12 items" next to the panel title. */
  meta: string | undefined;
  /** The list of the selected tab, or the search results while searching (a FlatList that fills the panel and scrolls on its own). */
  list: ReactNode;
  /** The text in the search field. */
  query: string;
  onQuery: (query: string) => void;
  /** The results of the search are in the list: the filter chips step aside. */
  searching: boolean;
  /** A spinner in the search field. */
  searchBusy: boolean;
  /** To focus the search field from outside (the "Search foods" button of an empty list). */
  searchInputRef: RefObject<TextInputInstance | null>;
  onScan: () => void;
  onCreateFood: () => void;
  onCreateRecipe: () => void;
  onNewSavedMeal: () => void;
}) {
  const { colors, radius } = useTheme();
  const [width, onLayout] = useAvailableWidth();
  const sideVisible = width >= SIDE_MIN_CONTENT_WIDTH;

  return (
    <DesktopPage
      title="Foods"
      scroll={false}
      right={
        sideVisible ? undefined : (
          <>
            <ToolbarButton label="Create food" onPress={onCreateFood} />
            <ToolbarButton label="Create recipe" onPress={onCreateRecipe} />
            <ToolbarButton label="New saved meal" onPress={onNewSavedMeal} />
          </>
        )
      }>
      <View style={styles.fill} onLayout={onLayout}>
        <View style={styles.row}>
          <Panel title="Food library" meta={meta} flush style={styles.main}>
            <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
              <View style={styles.searchRow}>
                <SearchField variant="panel" value={query} onChangeText={onQuery} busy={searchBusy} inputRef={searchInputRef} />
                <ScanButton variant="panel" onPress={onScan} />
              </View>
              {searching ? null : (
                <View accessibilityRole="tablist" style={styles.chips}>
                  {tabs.map((t) => {
                    const selected = t.value === tab;
                    return (
                      <Pressable
                        key={t.value}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        onPress={() => onTab(t.value)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: selected ? colors.primary : colors.surfaceAlt,
                            borderColor: selected ? colors.primary : colors.border,
                            borderRadius: radius.pill,
                          },
                        ]}>
                        <Text style={[styles.chipText, { color: selected ? colors.onPrimary : colors.text }]}>{t.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
            {list}
          </Panel>
          {sideVisible ? (
            <View style={styles.side}>
              <Panel title="Create">
                <ToolbarButton block label="Create food" onPress={onCreateFood} />
                <ToolbarButton block label="Create recipe" onPress={onCreateRecipe} />
                <ToolbarButton block label="New saved meal" onPress={onNewSavedMeal} />
              </Panel>
              <Panel title="Good to know">
                <AppText variant="small" muted>
                  Type in the search field to find any food right here. The + on a result adds one serving to the diary.
                </AppText>
                <AppText variant="small" muted>
                  Tap the star on a food to keep it under Favorites. Recent lists what you logged lately.
                </AppText>
                <AppText variant="small" muted>
                  A recipe turns a list of ingredients into one food with calories per serving.
                </AppText>
                <AppText variant="small" muted>
                  A saved meal adds several foods to a diary meal in one go. Save one from the menu of a diary meal, or build one here.
                </AppText>
              </Panel>
            </View>
          ) : null}
        </View>
      </View>
    </DesktopPage>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row', alignItems: 'stretch', gap: 12 },
  main: { flex: 1 },
  toolbar: { padding: 12, gap: 10, borderBottomWidth: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { minHeight: 28, paddingHorizontal: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 12.5, fontWeight: '600' },
  side: { width: SIDE_WIDTH, flexShrink: 0, alignSelf: 'flex-start', gap: 12 },
});
