// The building blocks of the desktop page layouts (windows of WIDE_BREAKPOINT or more): bordered panels with a slim title strip, the
// page header strip, a KPI strip, a grid that lays panels into equal-height rows and bar lists with aligned columns. Phones never
// render any of this. The rules (column plans, row packing, text column widths) are pure and live in desktop-layout.ts.
//
// Corners come from `useTheme().radius` / `.shape` only (tools/ui-smoke/src/shape-guard.test.ts), colours from `useTheme().colors`.
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Children, isValidElement, useCallback, useState, type ReactElement, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme, type ThemeColors } from '@/theme';
import {
  DESKTOP_CONTENT_MAX_WIDTH,
  DESKTOP_CONTENT_PADDING,
  PAGE_HEADER_HEIGHT,
  PANEL_GAP,
  PANEL_HEADER_HEIGHT,
} from '@/theme/desktop';

import {
  DIARY_LIST_MIN_WIDTH,
  chunk,
  clampSpan,
  estimateContentWidth,
  kpiColumns,
  packRows,
  planDiary,
  planGrid,
  textColumnWidth,
  type BarRow,
  type BarTone,
} from './desktop-layout';

/** Panels, strips and the page header are drawn with a 1 px border. */
const BORDER = 1;
/** Space between a panel's edge and its content. */
const BODY_PADDING = 14;
const BODY_GAP = 12;

/**
 * The width a block has, measured with onLayout; until the first measurement a guess from the window (the sidebar and the page
 * padding taken off) so the first frame already has the right number of columns.
 */
export function useAvailableWidth(): [number, (e: LayoutChangeEvent) => void] {
  const windowWidth = useWindowDimensions().width;
  const [measured, setMeasured] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    setMeasured((prev) => (prev === next ? prev : next));
  }, []);
  return [measured > 0 ? measured : estimateContentWidth(windowWidth), onLayout];
}

const toneColor = (tone: BarTone, colors: ThemeColors): string =>
  tone === 'success' ? colors.success : tone === 'danger' ? colors.danger : colors.textMuted;

// ------------------------------------------------------------------------------------------------ page

/**
 * The slim strip at the top of a desktop tab page: title (and a muted subtitle after it, e.g. the date) at the left edge of the
 * content area, a slot at the right edge (actions, status), a hairline underneath.
 */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string | undefined; right?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.pageHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <View style={styles.pageHeaderInner}>
        <View style={styles.pageHeaderLeft}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.pageTitle, { color: colors.text }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={[styles.pageSubtitle, { color: colors.textMuted }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={styles.pageHeaderRight}>{right}</View> : null}
      </View>
    </View>
  );
}

/**
 * A desktop tab page: the PageHeader on top (always visible) and the content under it, centred at the widest DESKTOP_CONTENT_MAX_WIDTH
 * with DESKTOP_CONTENT_PADDING around it. `scroll` (default) lets the page scroll; without it the content fills the rest of the
 * window (for a page whose panes scroll on their own, like the foods list).
 */
export function DesktopPage({
  title,
  subtitle,
  right,
  children,
  scroll = true,
  refreshControl,
}: {
  title: string;
  subtitle?: string | undefined;
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  refreshControl?: ScrollViewProps['refreshControl'];
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { backgroundColor: colors.background }]}>
      <PageHeader title={title} subtitle={subtitle} right={right} />
      {scroll ? (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}>
          <View style={styles.content}>{children}</View>
        </ScrollView>
      ) : (
        <View style={[styles.fill, styles.fixedContent]}>
          <View style={[styles.content, styles.fill]}>{children}</View>
        </View>
      )}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ panel

export interface PanelAction {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}

/**
 * A bordered box with a slim title strip: small semibold title at the left, a muted `meta` next to it, a link-like `action` (and
 * any `headerRight` controls) at the right and a hairline under the strip. The body has 14 px padding, or none with `flush` (lists
 * and tables that run edge to edge). `tone="page"` paints the panel in the page colour instead of the surface colour, for lists
 * whose rows are drawn in the page colour already. With `collapsible` the whole title strip is a button that hides the body.
 * Inside a PanelGrid a panel grows to the height of its row; `span` (read by the grid) makes it take more than one column.
 */
export function Panel({
  title,
  meta,
  action,
  headerRight,
  collapsible,
  children,
  flush = false,
  tone = 'surface',
  style,
  bodyStyle,
}: {
  title: string;
  meta?: string | undefined;
  action?: PanelAction | undefined;
  headerRight?: ReactNode;
  collapsible?: { collapsed: boolean; onToggle: () => void; accessibilityLabel: string } | undefined;
  children?: ReactNode;
  flush?: boolean;
  tone?: 'surface' | 'page';
  /** Columns taken in a PanelGrid (default 1). Read by the grid, not drawn. */
  span?: number;
  style?: StyleProp<ViewStyle>;
  bodyStyle?: StyleProp<ViewStyle>;
}) {
  const { colors, radius } = useTheme();
  const collapsed = collapsible?.collapsed === true;
  const showBody = !collapsed;

  const heading = (
    <>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.panelTitle, { color: colors.text }]}>
        {title}
      </Text>
      {meta ? (
        <Text numberOfLines={1} style={[styles.panelMeta, { color: colors.textMuted }]}>
          {meta}
        </Text>
      ) : null}
    </>
  );
  const right = (
    <>
      {headerRight}
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          hitSlop={6}
          onPress={action.onPress}
          style={({ pressed }) => [styles.panelAction, pressed && { opacity: 0.6 }]}>
          <Text numberOfLines={1} style={[styles.panelActionText, { color: colors.primary }]}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
  const headerStyle = [styles.panelHeader, showBody && { borderBottomWidth: BORDER, borderBottomColor: colors.border }];

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: tone === 'page' ? colors.background : colors.surface,
          borderColor: colors.border,
          borderRadius: radius.lg,
        },
        collapsed && styles.panelCollapsed,
        style,
      ]}>
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={collapsible.accessibilityLabel}
          onPress={collapsible.onToggle}
          style={({ pressed }) => [headerStyle, pressed && { backgroundColor: colors.surfaceAlt }]}>
          {heading}
          <View style={styles.spacer} />
          <SymbolView
            name={{ ios: collapsed ? 'chevron.right' : 'chevron.down', android: collapsed ? 'chevron_right' : 'expand_more' }}
            size={12}
            tintColor={colors.textMuted}
            fallback={<Text style={[styles.chevronGlyph, { color: colors.textMuted }]}>{collapsed ? '\u25B8' : '\u25BE'}</Text>}
          />
        </Pressable>
      ) : (
        <View style={headerStyle}>
          {heading}
          <View style={styles.spacer} />
          {right}
        </View>
      )}
      {showBody ? <View style={[styles.panelBody, flush ? null : styles.panelBodyPadded, bodyStyle]}>{children}</View> : null}
    </View>
  );
}

/** Small tab-like buttons for the title strip of a panel (7 / 14 / 30 days). */
export function PanelTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; accessibilityLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors, radius, shape } = useTheme();
  return (
    <View style={[styles.tabs, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.pill }]}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.accessibilityLabel ?? opt.label}
            onPress={() => onChange(opt.value)}
            style={[styles.tab, { borderRadius: shape.inner(radius.pill, TABS_PADDING) }, selected && { backgroundColor: colors.primary }]}>
            <Text style={[styles.tabLabel, { color: selected ? colors.onPrimary : colors.text }]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const TABS_PADDING = 2;

/** A small bordered button for the page header (Food, Exercise, ...) and panels: optional symbol, label, 28 px high. */
export function ToolbarButton({
  label,
  onPress,
  accessibilityLabel,
  symbol,
  primary = false,
  block = false,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  symbol?: SymbolViewProps['name'];
  primary?: boolean;
  /** Fills the width of its column and is a little taller (a stack of actions in a panel). */
  block?: boolean;
}) {
  const { colors, radius } = useTheme();
  const ink = primary ? colors.onPrimary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarButton,
        block && styles.toolbarBlock,
        {
          backgroundColor: primary ? colors.primary : pressed ? colors.surfaceAlt : colors.surface,
          borderColor: primary ? colors.primary : colors.border,
          borderRadius: radius.md,
          opacity: primary && pressed ? 0.85 : 1,
        },
      ]}>
      {symbol ? <SymbolView name={symbol} size={14} tintColor={primary ? colors.onPrimary : colors.primary} /> : null}
      <Text style={[styles.toolbarLabel, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------------------------------------ grid

type SpanProps = { span?: number };

const spanOf = (element: ReactElement): number | undefined => (element.props as SpanProps).span;

/**
 * Lays panels into rows of equal height: 1 column on a narrow content, 2 up to ~1120 px, 3 above (desktop-layout.ts planGrid; or the
 * `columns` you pass). Panels are dealt out in order; a child with a `span` prop takes that many columns. Every panel of a row has
 * `flex: span`, so a last row with fewer panels still fills the width, and a panel grows to the height of its row.
 */
export function PanelGrid({ children, columns, gap = PANEL_GAP }: { children: ReactNode; columns?: number; gap?: number }) {
  const [width, onLayout] = useAvailableWidth();
  const items = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const plan = planGrid(width, { columns, gap });
  const rows = packRows(items.map(spanOf), plan.columns);
  return (
    <View onLayout={onLayout} style={[styles.grid, { gap: plan.gap }]}>
      {rows.map((row) => (
        <View key={row.map((i) => items[i]?.key ?? i).join('|')} style={[styles.gridRow, { gap: plan.gap }]}>
          {row.map((i) => {
            const item = items[i] as ReactElement;
            return (
              <View key={item.key ?? i} style={[styles.gridCell, { flexGrow: clampSpan(spanOf(item), plan.columns) }]}>
                {item}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * Two panes side by side (the main one about 58 %, at least 520 px; the side one the rest) from a content width of ~900 px, one
 * stacked column below it (desktop-layout.ts planDiary). The side pane is only as tall as its panels.
 */
export function SplitPanes({ main, side, gap = PANEL_GAP }: { main: ReactNode; side: ReactNode; gap?: number }) {
  const [width, onLayout] = useAvailableWidth();
  const plan = planDiary(width, gap);
  return (
    <View onLayout={onLayout} style={plan.split ? [styles.panes, { gap }] : { gap }}>
      <View style={plan.split ? [styles.pane, { flexGrow: plan.listFlex, minWidth: DIARY_LIST_MIN_WIDTH }] : undefined}>{main}</View>
      <View style={plan.split ? [styles.pane, { flexGrow: plan.sideFlex, gap }] : { gap }}>{side}</View>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ KPI strip

/**
 * One bordered strip split into equal cells with hairline dividers (the "Health this morning" look). Wraps to more rows when the
 * strip is narrow: six cells become 3 + 3 (kpiColumns). Put KpiCells in it.
 */
export function KpiStrip({ children }: { children: ReactNode }) {
  const { colors, radius } = useTheme();
  const [width, onLayout] = useAvailableWidth();
  const cells = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const rows = chunk(cells, kpiColumns(width, cells.length));
  return (
    <View
      onLayout={onLayout}
      style={[styles.strip, { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg }]}>
      {rows.map((row, r) => (
        <View
          key={row.map((cell, c) => cell.key ?? c).join('|')}
          style={[styles.stripRow, r > 0 && { borderTopWidth: BORDER, borderTopColor: colors.border }]}>
          {row.map((cell, c) => (
            <View
              key={cell.key ?? c}
              style={[styles.stripSlot, c > 0 && { borderLeftWidth: BORDER, borderLeftColor: colors.border }]}>
              {cell}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * A cell of a KpiStrip: small muted label, a big value with a small unit, an optional delta line and an optional visual (a
 * Sparkline, a MiniProgress) at the bottom of the cell so the visuals of neighbouring cells line up.
 */
export function KpiCell({
  label,
  value,
  unit,
  delta,
  deltaTone = 'muted',
  valueAccessibilityLabel,
  children,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  delta?: string | undefined;
  deltaTone?: BarTone;
  valueAccessibilityLabel?: string;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.kpiCell}>
      <Text numberOfLines={1} style={[styles.kpiLabel, { color: colors.textMuted }]}>
        {label}
      </Text>
      <View style={styles.kpiValueRow}>
        <Text numberOfLines={1} accessibilityLabel={valueAccessibilityLabel} style={[styles.kpiValue, { color: colors.text }]}>
          {value}
        </Text>
        {unit ? (
          <Text numberOfLines={1} style={[styles.kpiUnit, { color: colors.textMuted }]}>
            {unit}
          </Text>
        ) : null}
      </View>
      {delta ? (
        <Text numberOfLines={2} style={[styles.kpiDelta, { color: toneColor(deltaTone, colors) }]}>
          {delta}
        </Text>
      ) : null}
      {children ? <View style={styles.kpiVisual}>{children}</View> : null}
    </View>
  );
}

/**
 * A thin progress strip for a KPI cell. `fraction` over 1 is drawn full in `overColor`. Without an `accessibilityLabel` it is
 * decorative (hidden from screen readers): the cell's own texts already say the same.
 */
export function MiniProgress({
  fraction,
  color,
  overColor,
  accessibilityLabel,
}: {
  fraction: number | undefined;
  color: string;
  overColor?: string;
  accessibilityLabel?: string;
}) {
  const { colors, shape } = useTheme();
  const raw = fraction === undefined || !Number.isFinite(fraction) ? 0 : Math.max(0, fraction);
  const fill = Math.min(1, raw);
  return (
    <View
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel === undefined ? undefined : 'progressbar'}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityLabel === undefined ? undefined : { min: 0, max: 100, now: Math.min(100, Math.round(raw * 100)) }}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'auto'}
      style={[styles.miniTrack, { backgroundColor: colors.track, borderRadius: shape.bar(MINI_TRACK_HEIGHT) }]}>
      <View style={{ width: `${fill * 100}%`, height: '100%', backgroundColor: raw > 1 && overColor ? overColor : color }} />
    </View>
  );
}

const MINI_TRACK_HEIGHT = 4;

// ------------------------------------------------------------------------------------------------ bar list

const BAR_HEIGHT = 8;
/** Width of one character of a 12 px tabular figure, rounded up a little. */
const VALUE_CHAR_WIDTH = 6.9;
/** Width of one character of the bold 12 px percentage, with room to spare. */
const PCT_CHAR_WIDTH = 9;

/** Rows of label | bar | value | percentage, with the value and percentage columns as wide as their widest text so the bars line up. */
export function BarList({ rows, labelWidth = 76 }: { rows: BarRow[]; labelWidth?: number }) {
  const { colors, shape } = useTheme();
  const valueWidth = textColumnWidth(
    rows.map((r) => r.valueText),
    VALUE_CHAR_WIDTH,
  );
  // A bold 12 px "126%" is about 34 px wide in the system font, and wider in some fonts: the column is generous (and never below 44).
  const pctWidth = textColumnWidth(
    rows.map((r) => r.pctText),
    PCT_CHAR_WIDTH,
    44,
  );
  return (
    <View style={styles.barList}>
      {rows.map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={row.accessibilityLabel}
          accessibilityValue={row.now === undefined ? undefined : { min: 0, max: 100, now: row.now }}
          style={styles.barRow}>
          <Text numberOfLines={1} style={[styles.barLabel, { width: labelWidth, color: colors.text }]}>
            {row.label}
          </Text>
          <View style={[styles.barTrack, { backgroundColor: colors.track, borderRadius: shape.bar(BAR_HEIGHT) }]}>
            <View style={[styles.barSegment, { left: 0, width: `${row.fill * 100}%`, backgroundColor: row.color }]} />
            {row.markAt !== undefined ? (
              <>
                <View
                  style={[
                    styles.barSegment,
                    { left: `${row.markAt * 100}%`, width: `${row.overFill * 100}%`, backgroundColor: row.overColor },
                  ]}
                />
                <View style={[styles.barNotch, { left: `${row.markAt * 100}%`, backgroundColor: colors.surface }]} />
              </>
            ) : null}
          </View>
          <Text numberOfLines={1} style={[styles.barValue, { width: valueWidth, color: colors.textMuted }]}>
            {row.valueText}
          </Text>
          <Text numberOfLines={1} style={[styles.barPct, { width: pctWidth, color: toneColor(row.tone, colors) }]}>
            {row.pctText}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // page
  page: { flex: 1 },
  fill: { flex: 1 },
  fixedContent: { minHeight: 0 },
  scrollContent: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: DESKTOP_CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    padding: DESKTOP_CONTENT_PADDING,
    gap: PANEL_GAP,
  },
  pageHeader: { height: PAGE_HEADER_HEIGHT, borderBottomWidth: BORDER, justifyContent: 'center' },
  // Starts at the left edge of the content area and ends at its right edge, like the stack pages' header: not centred in the
  // page's content column.
  pageHeaderInner: {
    width: '100%',
    paddingHorizontal: DESKTOP_CONTENT_PADDING,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pageHeaderLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexShrink: 1, minWidth: 0 },
  pageHeaderRight: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  pageTitle: { fontSize: 15, fontWeight: '600' },
  pageSubtitle: { fontSize: 13, fontWeight: '400', flexShrink: 1 },
  // panel
  panel: { flexGrow: 1, borderWidth: BORDER, overflow: 'hidden' },
  // A collapsed panel is only its title strip, even beside a taller panel of the same row.
  panelCollapsed: { flexGrow: 0 },
  panelHeader: {
    minHeight: PANEL_HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: BODY_PADDING,
  },
  panelTitle: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  panelMeta: { fontSize: 12, fontWeight: '400', flexShrink: 1 },
  panelAction: { minHeight: 24, justifyContent: 'center' },
  panelActionText: { fontSize: 12, fontWeight: '600' },
  chevronGlyph: { fontSize: 12 },
  spacer: { flex: 1 },
  panelBody: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  panelBodyPadded: { padding: BODY_PADDING, gap: BODY_GAP },
  // tabs / toolbar
  tabs: { flexDirection: 'row', borderWidth: BORDER, padding: TABS_PADDING, gap: TABS_PADDING },
  tab: { minHeight: 20, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 11.5, fontWeight: '600' },
  toolbarButton: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderWidth: BORDER,
  },
  toolbarBlock: { alignSelf: 'stretch', justifyContent: 'center', minHeight: 34 },
  toolbarLabel: { fontSize: 12.5, fontWeight: '600' },
  // grid
  grid: { width: '100%' },
  gridRow: { flexDirection: 'row', alignItems: 'stretch' },
  gridCell: { flexShrink: 1, flexBasis: 0, minWidth: 0 },
  // split panes
  panes: { flexDirection: 'row', alignItems: 'flex-start' },
  pane: { flexShrink: 1, flexBasis: 0 },
  // kpi
  strip: { borderWidth: BORDER, overflow: 'hidden' },
  stripRow: { flexDirection: 'row', alignItems: 'stretch' },
  stripSlot: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  kpiCell: { flexGrow: 1, paddingHorizontal: BODY_PADDING, paddingVertical: 12, gap: 2 },
  kpiLabel: { fontSize: 11.5, fontWeight: '500' },
  kpiValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  kpiValue: { fontSize: 25, fontWeight: '600', fontVariant: ['tabular-nums'] },
  kpiUnit: { fontSize: 12, fontWeight: '400' },
  kpiDelta: { fontSize: 12, fontWeight: '400', fontVariant: ['tabular-nums'] },
  kpiVisual: { marginTop: 'auto', paddingTop: 8 },
  miniTrack: { height: MINI_TRACK_HEIGHT, overflow: 'hidden' },
  // bar list
  barList: { gap: 4 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 26 },
  barLabel: { fontSize: 13, fontWeight: '600' },
  barTrack: { flex: 1, minWidth: 36, height: BAR_HEIGHT, overflow: 'hidden' },
  barSegment: { position: 'absolute', top: 0, bottom: 0 },
  barNotch: { position: 'absolute', top: 0, bottom: 0, width: 2, marginLeft: -1 },
  barValue: { fontSize: 12, textAlign: 'right', flexShrink: 1, fontVariant: ['tabular-nums'] },
  barPct: { fontSize: 12, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
});
