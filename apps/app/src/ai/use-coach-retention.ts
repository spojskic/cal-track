import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys } from '@/data/keys';
import { useProfile } from '@/data/profile';
import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

/**
 * Coach chat retention (privacy): `profiles.coach_auto_delete` (messages older than the retention window,
 * 3 months by default, are purged by a scheduled job) and "delete all my coach chats now"
 * (RPC `delete_all_my_coach_data`). Only the chat text lives in Supabase; the OpenRouter key never does.
 */
export function useCoachRetention() {
  const qc = useQueryClient();
  const profile = useProfile();

  const setAutoDelete = useMutation({
    mutationFn: async (value: boolean): Promise<boolean> => {
      const userId = await requireUserId();
      const { error } = await supabase.from('profiles').update({ coach_auto_delete: value }).eq('user_id', userId);
      if (error) throw error;
      return value;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.profile }),
  });

  const deleteAll = useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('delete_all_my_coach_data');
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coach'] }),
  });

  const saved = profile.data?.coach_auto_delete ?? true;
  // Show the pending choice immediately; fall back to the saved value.
  const autoDelete = setAutoDelete.isPending ? Boolean(setAutoDelete.variables) : saved;

  return {
    loading: profile.isLoading,
    ready: Boolean(profile.data),
    autoDelete,
    setAutoDelete,
    deleteAll,
  };
}
