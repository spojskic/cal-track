import Svg, { Circle, Path } from 'react-native-svg';

/**
 * Small drawn icons for round buttons (+, back arrow, ...). They are vector paths on a 24 x 24 grid, so they sit in the exact
 * middle of their button on every platform. Text characters such as "+" or the single angle quote cannot do that: each font
 * puts them at a different height and width, which is what made the icons look off-centre in the web build.
 */
export type GlyphName = 'plus' | 'minus' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'dots' | 'close' | 'check';

/** Characters callers pass around today (IconButton `glyph`) and the drawn icon that replaces each of them. */
const BY_CHAR: Record<string, GlyphName> = {
  '+': 'plus',
  '\u2212': 'minus',
  '-': 'minus',
  '\u2039': 'chevron-left',
  '\u203A': 'chevron-right',
  '\u22EF': 'dots',
  '\u00D7': 'close',
  '\u2715': 'close',
  '\u2713': 'check',
};

export function glyphNameFor(char: string): GlyphName | null {
  return BY_CHAR[char] ?? null;
}

export function Glyph({
  name,
  size = 20,
  color,
  strokeWidth = 2.2,
}: {
  name: GlyphName;
  /** Width and height in px. */
  size?: number;
  color: string;
  /** Line weight in grid units (of 24). */
  strokeWidth?: number;
}) {
  const stroke = { stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" pointerEvents="none">
      {name === 'plus' ? <Path d="M12 5v14M5 12h14" {...stroke} /> : null}
      {name === 'minus' ? <Path d="M5 12h14" {...stroke} /> : null}
      {name === 'chevron-left' ? <Path d="M14.5 5.5 8 12l6.5 6.5" {...stroke} /> : null}
      {name === 'chevron-right' ? <Path d="M9.5 5.5 16 12l-6.5 6.5" {...stroke} /> : null}
      {name === 'chevron-down' ? <Path d="M5.5 9.5 12 16l6.5-6.5" {...stroke} /> : null}
      {name === 'close' ? <Path d="M6 6l12 12M18 6 6 18" {...stroke} /> : null}
      {name === 'check' ? <Path d="M5 12.5l4.5 4.5L19 7.5" {...stroke} /> : null}
      {name === 'dots' ? (
        <>
          <Circle cx={5.5} cy={12} r={2} fill={color} />
          <Circle cx={12} cy={12} r={2} fill={color} />
          <Circle cx={18.5} cy={12} r={2} fill={color} />
        </>
      ) : null}
    </Svg>
  );
}
