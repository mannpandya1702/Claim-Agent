import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Save, Undo2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/format";
import { qk, saveStaffNotes } from "@/lib/queries";
import type { CallInteraction } from "@/lib/types";
import { cn } from "@/lib/utils";

export const NOTES_MAX = 4000;

interface StaffNotesProps {
  callId: string;
  /** The saved value from call_interactions.staff_notes. */
  notes: string | null | undefined;
  className?: string;
}

/**
 * Staff notes, the one browser-writable column. A policy denial updates zero rows and still
 * returns success, so saveStaffNotes selects the row back and only that confirmed value is
 * shown as saved.
 */
export function StaffNotes({ callId, notes, className }: StaffNotesProps) {
  const id = useId();
  const queryClient = useQueryClient();
  const server = notes ?? "";
  const [draft, setDraft] = useState(server);
  // The last value known to be stored: the prop, or what the save confirmed by selecting it back.
  const [saved, setSaved] = useState(server);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  // A new stored value (Realtime, another tab) replaces an untouched draft, but never text
  // someone is in the middle of writing.
  useEffect(() => {
    if (server === savedRef.current) return;
    const current = draftRef.current;
    if (current === savedRef.current || current === server) {
      setDraft(server);
      setChangedElsewhere(false);
    } else {
      setChangedElsewhere(true);
    }
    setSaved(server);
  }, [server]);

  const save = useMutation({
    mutationFn: (text: string) => saveStaffNotes(callId, text),
    onSuccess: (confirmed) => {
      const value = confirmed ?? "";
      setSaved(value);
      setDraft(value);
      setChangedElsewhere(false);
      setSavedAt(new Date());
      queryClient.setQueryData<CallInteraction | null>(qk.callRow(callId), (old) => (old ? { ...old, staff_notes: confirmed } : old));
      toast.success("Notes saved");
    },
  });

  const dirty = draft !== saved;
  const submit = () => {
    if (!dirty || save.isPending) return;
    save.mutate(draft);
  };

  return (
    <form
      className={cn("space-y-2", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={id} className="sr-only">
        Staff notes
      </Label>
      <Textarea
        id={id}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (save.isError) save.reset();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        maxLength={NOTES_MAX}
        rows={4}
        placeholder="What happened, what was promised, who is following up."
        aria-describedby={`${id}-status`}
        aria-invalid={save.isError || undefined}
        className="min-h-24 resize-y"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-status`} aria-live="polite" className={cn("text-xs", save.isError ? "text-critical-ink" : "text-ink-3")}>
          {save.isPending
            ? "Saving"
            : save.isError
              ? `Not saved: ${errorMessage(save.error)}`
              : changedElsewhere
                ? "Someone else saved new notes. Saving replaces them."
                : dirty
                  ? "Unsaved changes. Ctrl+Enter saves."
                  : savedAt
                    ? `Saved at ${formatTime(savedAt)}`
                    : saved
                      ? "Saved"
                      : "Visible to staff only."}
        </p>
        <div className="flex items-center gap-2">
          {dirty && !save.isPending && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(saved);
                setChangedElsewhere(false);
                save.reset();
              }}
            >
              <Undo2 aria-hidden="true" />
              Revert
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : !dirty && savedAt ? (
              <Check aria-hidden="true" />
            ) : (
              <Save aria-hidden="true" />
            )}
            {!dirty && savedAt ? "Saved" : "Save notes"}
          </Button>
        </div>
      </div>
    </form>
  );
}
