import type { ComponentProps } from 'react';

import { NumberField } from '@/components/forms';

type FieldProps = ComponentProps<typeof NumberField>;

/**
 * Thin wrapper over NumberField with a plain `(text: string) => void` onChange.
 * NumberField's props currently intersect TextInput's event-style `onChange` with its own text
 * callback, which rejects ordinary state setters; the cast is isolated here.
 */
export function DecimalField({
  onChange,
  ...rest
}: Omit<FieldProps, 'onChange'> & { onChange: (text: string) => void }) {
  return <NumberField {...rest} onChange={onChange as FieldProps['onChange']} />;
}
