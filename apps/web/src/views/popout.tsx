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
import { isMac } from "../utils/platform";
import { TITLE_BAR_HEIGHT } from "../components/title-bar";
import {
  Icon,
  PasswordInvisible as Visible,
  Pin,
  PinFilled,
  Privacy as Hidden
} from "../components/icons";

type PopoutState = {
  alwaysOnTop: boolean;
  privacyMode: boolean;
  screenCaptureBlocked: boolean;
  hasTitleBarOverlay: boolean;
};

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
            <PopoutTitleBar />
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
 * The popout's title bar (drawn next to the native window controls) or, with
 * a native title bar, a slim bar below it. Holds the per window toggles:
 * always on top & (in privacy mode) visibility while screen sharing.
 */
function PopoutTitleBar() {
  const noteId = getPopoutNoteId();
  const title = useEditorStore((store) => store.getActiveSession()?.title);
  const [state, setState] = useState<PopoutState>();

  useEffect(() => {
    if (!noteId || !desktop) return;
    const subscription = desktop.popout.onStateChanged.subscribe(
      { noteId },
      { onData: setState }
    );
    return () => subscription.unsubscribe();
  }, [noteId]);

  if (!noteId || !state) return null;

  const controls: {
    id: string;
    title: string;
    icon: Icon;
    toggled: boolean;
    onClick: () => void;
  }[] = [
    {
      id: "popout-always-on-top",
      title: strings.alwaysOnTop(),
      icon: state.alwaysOnTop ? PinFilled : Pin,
      toggled: state.alwaysOnTop,
      onClick: () =>
        desktop?.popout.setAlwaysOnTop.mutate({
          noteId,
          enabled: !state.alwaysOnTop
        })
    }
  ];
  if (state.privacyMode)
    controls.push({
      id: "popout-screen-capture",
      title: state.screenCaptureBlocked
        ? strings.hiddenFromScreenSharing()
        : strings.visibleInScreenSharing(),
      icon: state.screenCaptureBlocked ? Hidden : Visible,
      toggled: !state.screenCaptureBlocked,
      onClick: () =>
        desktop?.popout.setScreenCaptureBlocked.mutate({
          noteId,
          blocked: !state.screenCaptureBlocked
        })
    });

  return (
    <Flex
      data-test-id="popout-title-bar"
      style={
        state.hasTitleBarOverlay
          ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
          : undefined
      }
      sx={{
        height: TITLE_BAR_HEIGHT,
        flexShrink: 0,
        alignItems: "center",
        gap: 1,
        // leave room for the native window controls
        pl: state.hasTitleBarOverlay && isMac() ? "80px" : 2,
        pr:
          state.hasTitleBarOverlay && !isMac()
            ? "calc(100vw - env(titlebar-area-width))"
            : 1,
        bg: "background-secondary",
        borderBottom: "1px solid var(--border)"
      }}
    >
      <Text
        variant="body"
        sx={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
      >
        {/* the native title bar already shows the title */}
        {state.hasTitleBarOverlay ? title : null}
      </Text>
      {controls.map((control) => (
        <Button
          key={control.id}
          data-test-id={control.id}
          aria-pressed={control.toggled}
          title={control.title}
          variant="secondary"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          sx={{
            p: 1,
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            bg: control.toggled ? "background-selected" : "transparent"
          }}
          onClick={control.onClick}
        >
          <control.icon size={16} />
        </Button>
      ))}
    </Flex>
  );
}
