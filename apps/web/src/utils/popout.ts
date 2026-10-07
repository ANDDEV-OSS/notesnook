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

import { create } from "zustand";

/**
 * Whether this renderer is a desktop popout window showing a single note
 * (opened via "Open in new window") instead of the full app.
 */
export const IS_POPOUT_WINDOW =
  IS_DESKTOP_APP && window.location.pathname === "/popout";

export function getPopoutNoteId() {
  return new URLSearchParams(window.location.search).get("note");
}

/**
 * Ids of notes currently open in popout windows. Only maintained in the
 * main window.
 */
export const usePoppedOutNotes = create<{ noteIds: string[] }>(() => ({
  noteIds: []
}));

export const poppedOutNoteIds = {
  has: (noteId: string) =>
    usePoppedOutNotes.getState().noteIds.includes(noteId),
  add: (noteId: string) => {
    if (!poppedOutNoteIds.has(noteId))
      usePoppedOutNotes.setState((s) => ({ noteIds: [...s.noteIds, noteId] }));
  },
  delete: (noteId: string) =>
    usePoppedOutNotes.setState((s) => ({
      noteIds: s.noteIds.filter((id) => id !== noteId)
    })),
  replace: (noteIds: string[]) => usePoppedOutNotes.setState({ noteIds })
};
