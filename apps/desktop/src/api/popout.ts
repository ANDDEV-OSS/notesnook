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

import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { BrowserWindow } from "electron";
import { EventEmitter } from "events";
import TypedEventEmitter from "typed-emitter";
import { z } from "zod";
import { isDevelopment } from "../utils";
import { AssetManager } from "../utils/asset-manager";
import { config } from "../utils/config";
import { PROTOCOL_URL } from "../utils/protocol";
import { getBackgroundColor, getTheme } from "../utils/theme";

type PopoutEvents = {
  popoutsChanged(noteIds: string[]): void;
  noteChanged(noteId: string): void;
};

// note ids are 24 character hex object ids (see getId in @notesnook/core)
const NoteId = z.string().regex(/^[a-f0-9]{24}$/);
// how long to wait for a popout to flush unsaved changes before closing it
const FLUSH_TIMEOUT = 3000;

const popouts = new Map<string, BrowserWindow>();
const emitter = new EventEmitter() as TypedEventEmitter<PopoutEvents>;
let setupWindow: ((window: BrowserWindow) => void) | undefined;

/**
 * Must be called once by the main process so popout windows get the same
 * IPC & navigation handling as the main window.
 */
export function configurePopouts(setup: (window: BrowserWindow) => void) {
  setupWindow = setup;
}

export function closeAllPopouts() {
  for (const window of popouts.values()) window.close();
}

function openPopout(noteId: string) {
  const existing = popouts.get(noteId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 700,
    height: 900,
    title: "Notesnook",
    darkTheme: getTheme() === "dark",
    backgroundColor: getBackgroundColor(),
    autoHideMenuBar: true,
    icon: AssetManager.appIcon({
      size: 512,
      format: process.platform === "win32" ? "ico" : "png"
    }),
    webPreferences: {
      zoomFactor: config.zoomFactor,
      spellcheck: config.isSpellCheckerEnabled,
      preload: __dirname + "/preload.js"
    }
  });
  window.setMenuBarVisibility(false);
  setupWindow?.(window);

  // give the popout a chance to save any pending edits before it closes
  let isFlushed = false;
  window.on("close", (event) => {
    if (isFlushed) return;
    event.preventDefault();
    isFlushed = true;
    Promise.race([
      window.webContents.executeJavaScript(`window.flushPopout?.()`),
      new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT))
    ])
      .catch((e) => console.error("Failed to flush popout", e))
      .finally(() => {
        if (!window.isDestroyed()) window.close();
      });
  });
  window.once("closed", () => {
    popouts.delete(noteId);
    emitter.emit("popoutsChanged", Array.from(popouts.keys()));
  });

  popouts.set(noteId, window);
  emitter.emit("popoutsChanged", Array.from(popouts.keys()));

  const url = new URL(isDevelopment() ? "http://localhost:3000" : PROTOCOL_URL);
  url.pathname = "/popout";
  url.searchParams.set("note", noteId);
  window.loadURL(url.toString());
}

const t = initTRPC.create();

export const popoutRouter = t.router({
  open: t.procedure
    .input(z.object({ noteId: NoteId }))
    .mutation(({ input }) => openPopout(input.noteId)),
  closeAll: t.procedure.mutation(() => closeAllPopouts()),
  notifyNoteChanged: t.procedure
    .input(z.object({ noteId: NoteId }))
    .mutation(({ input }) => {
      emitter.emit("noteChanged", input.noteId);
    }),
  onNoteChanged: t.procedure.subscription(() => {
    return observable<string>((emit) => {
      const listener = (noteId: string) => emit.next(noteId);
      emitter.addListener("noteChanged", listener);
      return () => {
        emitter.removeListener("noteChanged", listener);
      };
    });
  }),
  onPopoutsChanged: t.procedure.subscription(() => {
    return observable<string[]>((emit) => {
      const listener = (noteIds: string[]) => emit.next(noteIds);
      emitter.addListener("popoutsChanged", listener);
      emit.next(Array.from(popouts.keys()));
      return () => {
        emitter.removeListener("popoutsChanged", listener);
      };
    });
  })
});
