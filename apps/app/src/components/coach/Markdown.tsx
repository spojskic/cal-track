import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { spacing, useTheme } from '@/theme';

import { parseMarkdown, type MdSpan } from './markdown-parser';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' });

function Spans({ spans, codeBackground }: { spans: MdSpan[]; codeBackground: string }) {
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={[
            s.bold ? styles.bold : null,
            s.italic ? styles.italic : null,
            s.code ? [styles.code, { backgroundColor: codeBackground }] : null,
          ]}>
          {s.text}
        </Text>
      ))}
    </>
  );
}

/**
 * Renders the markdown subset of ./markdown.ts as plain React Native <Text>. Selectable, never interprets HTML,
 * never renders links or images. `partial` is set while a reply is still streaming.
 */
export function Markdown({
  text,
  color,
  partial = false,
  textStyle,
}: {
  text: string;
  color?: string;
  partial?: boolean;
  textStyle?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseMarkdown(text, { partial }), [text, partial]);
  const ink = color ?? colors.text;
  const codeBackground = `${ink}1F`;
  const base: StyleProp<TextStyle> = [styles.text, { color: ink }, textStyle];

  return (
    <View style={styles.root}>
      {blocks.map((block, bi) => {
        switch (block.type) {
          case 'paragraph':
            return (
              <Text key={bi} selectable style={base}>
                {block.lines.map((spans, li) => (
                  <Text key={li}>
                    {li > 0 ? '\n' : ''}
                    <Spans spans={spans} codeBackground={codeBackground} />
                  </Text>
                ))}
              </Text>
            );
          case 'heading':
            return (
              <Text key={bi} selectable style={[base, styles.heading]}>
                <Spans spans={block.spans} codeBackground={codeBackground} />
              </Text>
            );
          case 'list':
            return (
              <View key={bi} style={styles.list}>
                {block.items.map((item, ii) => (
                  <View key={ii} style={[styles.item, { paddingLeft: item.level * spacing.lg }]}>
                    <Text style={[base, styles.marker]}>
                      {item.marker}
                    </Text>
                    <Text selectable style={[base, styles.itemText]}>
                      <Spans spans={item.spans} codeBackground={codeBackground} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'rule':
            return <View key={bi} style={[styles.rule, { backgroundColor: `${ink}33` }]} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  text: { fontSize: 16, lineHeight: 23 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: { fontFamily: MONO, fontSize: 14 },
  heading: { fontWeight: '700' },
  list: { gap: spacing.xs },
  item: { flexDirection: 'row', gap: spacing.sm },
  marker: { minWidth: 18, textAlign: 'right' },
  itemText: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: spacing.xs },
});
