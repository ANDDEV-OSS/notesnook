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
import {
  isScreenCaptureBlockingSupported,
  setScreenCaptureBlocked
} from "../utils/screen-capture";
import { getBackgroundColor, getTheme } from "../utils/theme";

type PopoutEvents = {
  popoutsChanged(noteIds: string[]): void;
  noteChanged(noteId: string): void;
  stateChanged(): void;
};

export type PopoutState = {
  alwaysOnTop: boolean;
  // whether privacy mode applies to the popout (i.e. it can be hidden)
  privacyMode: boolean;
  screenCaptureBlocked: boolean;
  // whether the popout draws its own title bar next to the window controls
  hasTitleBarOverlay: boolean;
};

// note ids are 24 character hex object ids (see getId in @notesnook/core)
const NoteId = z.string().regex(/^[a-f0-9]{24}$/);
// how long to wait for a popout to flush unsaved changes before closing it
const FLUSH_TIMEOUT = 3000;

const popouts = new Map<string, BrowserWindow>();
// popouts where the user chose to allow screen capture despite privacy mode
const screenCaptureAllowed = new Set<string>();
const titleBarOverlayPopouts = new Set<string>();
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

/**
 * Applies the privacy mode setting to all popouts. Enabling it again also
 * revokes any screen capture allowed for individual popouts.
 */
export function setPopoutsPrivacyMode(enabled: boolean) {
  screenCaptureAllowed.clear();
  for (const window of popouts.values())
    setScreenCaptureBlocked(window, enabled);
  emitter.emit("stateChanged");
}

export function setPopoutsWindowControlsColor(symbolColor: string) {
  if (process.platform !== "win32") return;
  for (const noteId of titleBarOverlayPopouts)
    popouts.get(noteId)?.setTitleBarOverlay({ symbolColor });
}

function getPopoutState(noteId: string): PopoutState {
  const privacyMode = isScreenCaptureBlockingSupported && config.privacyMode;
  return {
    alwaysOnTop: !!popouts.get(noteId)?.isAlwaysOnTop(),
    privacyMode,
    screenCaptureBlocked: privacyMode && !screenCaptureAllowed.has(noteId),
    hasTitleBarOverlay: titleBarOverlayPopouts.has(noteId)
  };
}

function openPopout(noteId: string) {
  const existing = popouts.get(noteId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  // like the main window, draw the title bar ourselves (next to the native
  // window controls) unless the user prefers the native title bar
  const hasTitleBarOverlay =
    (process.platform === "win32" || process.platform === "darwin") &&
    !config.desktopSettings.nativeTitlebar;
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
    ...(hasTitleBarOverlay
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            height: 37,
            color: "#00000000",
            symbolColor: config.windowControlsIconColor
          },
          trafficLightPosition: { x: 16, y: 12 }
        }
      : {}),
    webPreferences: {
      zoomFactor: config.zoomFactor,
      spellcheck: config.isSpellCheckerEnabled,
      preload: __dirname + "/preload.js"
    }
  });
  window.setMenuBarVisibility(false);
  setScreenCaptureBlocked(window, getPopoutState(noteId).screenCaptureBlocked);
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
    screenCaptureAllowed.delete(noteId);
    titleBarOverlayPopouts.delete(noteId);
    emitter.emit("popoutsChanged", Array.from(popouts.keys()));
  });

  popouts.set(noteId, window);
  if (hasTitleBarOverlay) titleBarOverlayPopouts.add(noteId);
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
  setAlwaysOnTop: t.procedure
    .input(z.object({ noteId: NoteId, enabled: z.boolean() }))
    .mutation(({ input: { noteId, enabled } }) => {
      popouts.get(noteId)?.setAlwaysOnTop(enabled, "floating");
      emitter.emit("stateChanged");
    }),
  // lets a popout be captured (e.g. for screen sharing) in privacy mode until
  // it's closed or privacy mode is enabled again
  setScreenCaptureBlocked: t.procedure
    .input(z.object({ noteId: NoteId, blocked: z.boolean() }))
    .mutation(({ input: { noteId, blocked } }) => {
      const window = popouts.get(noteId);
      if (!window || !getPopoutState(noteId).privacyMode) return;
      if (blocked) screenCaptureAllowed.delete(noteId);
      else screenCaptureAllowed.add(noteId);
      setScreenCaptureBlocked(window, blocked);
      emitter.emit("stateChanged");
    }),
  onStateChanged: t.procedure
    .input(z.object({ noteId: NoteId }))
    .subscription(({ input: { noteId } }) => {
      return observable<PopoutState>((emit) => {
        const listener = () => emit.next(getPopoutState(noteId));
        emitter.addListener("stateChanged", listener);
        listener();
        return () => {
          emitter.removeListener("stateChanged", listener);
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
