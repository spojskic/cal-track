import { Stack } from 'expo-router';
import { useState } from 'react';

import {
  DateBanner,
  FormActions,
  FormError,
  FormScreen,
  closeScreen,
  errorMessage,
  hapticError,
  hapticSuccess,
  useTargetDate,
} from '@/components/activity';
import { TextField } from '@/components/forms';
import { useAddNote } from '@/data/activity-write';
import { spacing } from '@/theme';

const MAX_LENGTH = 5000;

export default function NewNoteScreen() {
  const date = useTargetDate();
  const [body, setBody] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const add = useAddNote();

  const empty = body.trim() === '';

  const onSave = async () => {
    setSubmitted(true);
    setSaveError(null);
    if (empty) return;
    try {
      await add.mutateAsync({ entryDate: date, body });
    } catch (e) {
      hapticError();
      setSaveError(errorMessage(e, 'Could not save the note.'));
      return;
    }
    hapticSuccess();
    closeScreen();
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Add note' }} />
      <FormScreen>
        <DateBanner date={date} />
        <TextField
          label="Note"
          value={body}
          onChangeText={setBody}
          placeholder="How did you feel? Anything worth remembering about today?"
          multiline
          numberOfLines={8}
          textAlignVertical="top"
          autoCapitalize="sentences"
          autoFocus
          maxLength={MAX_LENGTH}
          hint={`${body.length} / ${MAX_LENGTH}`}
          error={submitted && empty ? 'Write something first.' : null}
          style={{ minHeight: 180, paddingTop: spacing.md, paddingBottom: spacing.md }}
        />
        <FormError message={saveError} />
        <FormActions saveLabel="Save note" onSave={onSave} onCancel={closeScreen} saving={add.isPending} />
      </FormScreen>
    </>
  );
}
