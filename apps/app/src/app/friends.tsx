import { Stack } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ConfirmSheet } from '@/components/diary/ConfirmSheet';
import { TextField } from '@/components/forms';
import {
  NO_FRIENDS_TEXT,
  SHARING_NOTE,
  friendErrorMessage,
  friendsSince,
  parseFriendEmail,
  personSubtitle,
  personTitle,
  removeFriendMessage,
  requestDate,
  sendAnswerMessage,
} from '@/components/friends/friends-view';
import { PillButton } from '@/components/pill-button';
import { Badge, Divider, Note } from '@/components/settings/rows';
import { AppText, Button, Card, Screen } from '@/components/ui';
import {
  useFriendships,
  useRemoveFriendship,
  useRespondFriendRequest,
  useSendFriendRequest,
  type Friendship,
} from '@/data/friends';
import { spacing } from '@/theme';

/**
 * Friends (More > Friends): send a request to somebody's e-mail address, answer the requests you got, and see or remove your friends.
 * While two people are friends each sees the other's custom foods and recipes in the lists and the search; that is all that is shared.
 * The count on the More tab and on the Friends row is the notification: it appears when the app finds a new request.
 */
export default function FriendsScreen() {
  const list = useFriendships();
  const send = useSendFriendRequest();
  const respond = useRespondFriendRequest();
  const remove = useRemoveFriendship();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Friendship | null>(null);

  const submit = () => {
    const parsed = parseFriendEmail(email);
    setSentMessage(null);
    if (!parsed.ok) {
      setEmailError(parsed.error);
      return;
    }
    setEmailError(null);
    send.mutate(parsed.email, {
      onSuccess: (answer) => {
        setSentMessage(sendAnswerMessage(answer, parsed.email));
        setEmail('');
      },
    });
  };

  const nothing = list.data !== undefined && list.data.length === 0;
  const actionError = respond.error ?? remove.error;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Friends' }} />
      <View style={styles.stack}>
        <Card>
          <AppText variant="heading">Add a friend</AppText>
          <AppText variant="small" muted>
            {SHARING_NOTE}
          </AppText>
          <TextField
            label="Friend's e-mail"
            placeholder="anna@example.com"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setEmailError(null);
            }}
            error={emailError}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            maxLength={254}
            returnKeyType="send"
            onSubmitEditing={submit}
          />
          {send.error ? <Note tone="danger">{friendErrorMessage(send.error)}</Note> : null}
          {sentMessage ? <Note tone="success">{sentMessage}</Note> : null}
          <Button label="Send request" onPress={submit} loading={send.isPending} />
        </Card>

        {list.isLoading ? <AppText muted>Loading...</AppText> : null}
        {list.error ? (
          <Card>
            <Note tone="danger">{friendErrorMessage(list.error)}</Note>
            <Button label="Try again" variant="secondary" onPress={() => void list.refetch()} />
          </Card>
        ) : null}
        {actionError ? <Note tone="danger">{friendErrorMessage(actionError)}</Note> : null}

        {list.incoming.length > 0 ? (
          <Card>
            <View style={styles.headerRow}>
              <AppText variant="heading">Requests</AppText>
              <Badge label={String(list.incoming.length)} tone="primary" />
            </View>
            {list.incoming.map((request, i) => (
              <View key={request.id}>
                {i > 0 ? <Divider /> : null}
                <PersonRow person={request} detail={requestDate(request)}>
                  <PillButton
                    label="Accept"
                    tone="primary"
                    accessibilityLabel={`Accept friend request from ${personTitle(request)}`}
                    disabled={respond.isPending}
                    onPress={() => respond.mutate({ id: request.id, accept: true })}
                  />
                  <PillButton
                    label="Decline"
                    accessibilityLabel={`Decline friend request from ${personTitle(request)}`}
                    disabled={respond.isPending}
                    onPress={() => respond.mutate({ id: request.id, accept: false })}
                  />
                </PersonRow>
              </View>
            ))}
          </Card>
        ) : null}

        {list.outgoing.length > 0 ? (
          <Card>
            <AppText variant="heading">Waiting for an answer</AppText>
            {list.outgoing.map((request, i) => (
              <View key={request.id}>
                {i > 0 ? <Divider /> : null}
                <PersonRow person={request} detail={requestDate(request)}>
                  <PillButton
                    label="Cancel"
                    accessibilityLabel={`Cancel friend request to ${personTitle(request)}`}
                    disabled={remove.isPending}
                    onPress={() => remove.mutate(request.id)}
                  />
                </PersonRow>
              </View>
            ))}
          </Card>
        ) : null}

        <Card>
          <View style={styles.headerRow}>
            <AppText variant="heading">Friends</AppText>
            {list.data ? <Badge label={String(list.friends.length)} /> : null}
          </View>
          {list.data && list.friends.length === 0 ? (
            <AppText muted>{nothing ? NO_FRIENDS_TEXT : 'No friends yet. Accept a request or send one above.'}</AppText>
          ) : null}
          {list.friends.map((friend, i) => (
            <View key={friend.id}>
              {i > 0 ? <Divider /> : null}
              <PersonRow person={friend} detail={friendsSince(friend)}>
                <PillButton
                  label="Remove"
                  tone="danger"
                  accessibilityLabel={`Remove friend ${personTitle(friend)}`}
                  onPress={() => setToRemove(friend)}
                />
              </PersonRow>
            </View>
          ))}
        </Card>
      </View>

      <ConfirmSheet
        visible={toRemove !== null}
        title="Remove this friend?"
        message={toRemove ? removeFriendMessage(personTitle(toRemove)) : ''}
        confirmLabel="Remove friend"
        destructive
        onClose={() => setToRemove(null)}
        onConfirm={() => {
          if (toRemove) remove.mutate(toRemove.id);
        }}
      />
    </Screen>
  );
}

function PersonRow({ person, detail, children }: { person: Friendship; detail: string; children: ReactNode }) {
  const subtitle = personSubtitle(person);
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <AppText style={styles.name}>{personTitle(person)}</AppText>
        {subtitle ? <AppText variant="small" muted>{subtitle}</AppText> : null}
        <AppText variant="small" muted>{detail}</AppText>
      </View>
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  flex: { flex: 1 },
  name: { fontWeight: '700', fontSize: 16 },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', justifyContent: 'flex-end' },
});
