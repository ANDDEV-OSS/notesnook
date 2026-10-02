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

import { Suspense, useEffect, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import { Toaster } from "react-hot-toast";
import { strings } from "@notesnook/intl";
import TabsView from "../components/editor";
import GlobalMenuWrapper from "../components/global-menu-wrapper";
import { db } from "../common/db";
import { desktop } from "../common/desktop-bridge";
import { setupPopoutWindow } from "../common/popout";
import { useEditorStore } from "../stores/editor-store";
import { useStore as useSettingStore } from "../stores/setting-store";
import { getPopoutNoteId } from "../utils/popout";
import { logger } from "../utils/logger";

/**
 * A minimal view that shows a single note in its own desktop window
 * without any of the app's navigation, lists or other notes.
 */
function Popout() {
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async function () {
      const noteId = getPopoutNoteId();
      if (!noteId || !(await db.notes.exists(noteId))) {
        setError("Note not found.");
        return;
      }

      await useSettingStore.getState().refresh();
      await useEditorStore.getState().init();
      setupPopoutWindow(noteId);
      await useEditorStore.getState().openSession(noteId);
    })().catch((e) => {
      logger.error(e, "Failed to open note in popout");
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  return (
    <>
      <Suspense fallback={<div style={{ display: "none" }} />}>
        <div id="menu-wrapper">
          <GlobalMenuWrapper />
        </div>
      </Suspense>
      <Flex
        id="app"
        bg="background"
        sx={{ overflow: "hidden", flexDirection: "column", height: "100%" }}
      >
        {error ? (
          <Flex
            sx={{ flex: 1, alignItems: "center", justifyContent: "center" }}
          >
            <Text variant="body">{error}</Text>
          </Flex>
        ) : (
          <>
            <ScreenCaptureBanner />
            <TabsView hideActionBar />
          </>
        )}
        <Toaster containerClassName="toasts-container" />
      </Flex>
    </>
  );
}
export default Popout;

/**
 * Shown while privacy mode hides this window from screen capture, with a
 * one-time option to allow it (e.g. to share the note) until it's closed.
 */
function ScreenCaptureBanner() {
  const [isBlocked, setIsBlocked] = useState(false);

  useEffect(() => {
    const noteId = getPopoutNoteId();
    if (!noteId || !desktop) return;
    const subscription = desktop.popout.onScreenCaptureBlockedChanged.subscribe(
      { noteId },
      { onData: setIsBlocked }
    );
    return () => subscription.unsubscribe();
  }, []);

  if (!isBlocked) return null;
  return (
    <Flex
      data-test-id="screen-capture-banner"
      sx={{
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
        px: 2,
        py: 1,
        bg: "background-secondary",
        borderBottom: "1px solid var(--border)"
      }}
    >
      <Text variant="subBody">{strings.screenCaptureBlocked()}</Text>
      <Button
        variant="secondary"
        sx={{ flexShrink: 0 }}
        onClick={() => {
          const noteId = getPopoutNoteId();
          if (noteId) desktop?.popout.allowScreenCapture.mutate({ noteId });
        }}
      >
        {strings.allowScreenCaptureUntilClosed()}
      </Button>
    </Flex>
  );
}
