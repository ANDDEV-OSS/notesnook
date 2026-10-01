/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { DatabaseUpdatedEvent, EVENTS } from "@notesnook/core";
import { debounce } from "@notesnook/common";
import { db } from "./db";
import { desktop } from "./desktop-bridge";
import { useEditorStore } from "../stores/editor-store";
import { useStore as useNoteStore } from "../stores/note-store";
import { useKeyStore } from "../interfaces/key-store";
import { poppedOutNoteIds } from "../utils/popout";

declare global {
  interface Window {
    flushPopout?: () => Promise<void>;
  }
}

// must be longer than the editor's save debounce (see components/editor)
const SAVE_DEBOUNCE_MARGIN = 250;

/**
 * Moves a note from the main window into its own popout window.
 */
export async function openNoteInNewWindow(noteId: string) {
  if (!desktop) return;

  const { getSessionsForNote, saveSessionContentIfNotSaved, closeNotes } =
    useEditorStore.getState();
  await Promise.all(
    getSessionsForNote(noteId).map((s) => saveSessionContentIfNotSaved(s.id))
  );
  closeNotes(noteId);
  await useEditorStore.getState().waitForPendingSaves();

  await desktop.popout.open.mutate({ noteId });
}

/**
 * Keeps the main window in sync with any open popout windows.
 */
export function attachPopoutListeners() {
  if (!desktop) return;

  desktop.popout.onPopoutsChanged.subscribe(undefined, {
    onData(noteIds) {
      poppedOutNoteIds.clear();
      noteIds.forEach((id) => poppedOutNoteIds.add(id));
    }
  });

  // popouts write directly to the shared database so the main window
  // doesn't get any change events. Refresh the lists & request a sync
  // so the changes get pushed.
  const onNoteChanged = debounce(() => {
    useNoteStore.getState().refresh();
    db.eventManager.publish(EVENTS.databaseSyncRequested, false, false);
  }, 1000);
  desktop.popout.onNoteChanged.subscribe(undefined, {
    onData: () => onNoteChanged()
  });

  // popouts must not stay open when the app gets locked or the user logs out
  useKeyStore.subscribe(
    (state) => state.isLocked,
    (isLocked) => {
      if (isLocked) desktop?.popout.closeAll.mutate();
    }
  );
  db.eventManager.subscribe(EVENTS.userLoggedOut, () =>
    desktop?.popout.closeAll.mutate()
  );
}

/**
 * Wires up a popout window showing the note with `noteId`.
 */
export function setupPopoutWindow(noteId: string) {
  if (!desktop) return;

  const notifyNoteChanged = debounce(
    () => desktop?.popout.notifyNoteChanged.mutate({ noteId }),
    500
  );
  db.eventManager.subscribe(
    EVENTS.databaseUpdated,
    (event: DatabaseUpdatedEvent) => {
      if (event.collection === "notes" || event.collection === "content")
        notifyNoteChanged();
    }
  );

  // called by the main process before the window is closed
  window.flushPopout = async () => {
    const { sessions, saveSessionContentIfNotSaved, waitForPendingSaves } =
      useEditorStore.getState();
    await Promise.all(sessions.map((s) => saveSessionContentIfNotSaved(s.id)));
    await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MARGIN));
    await waitForPendingSaves();
  };
}
