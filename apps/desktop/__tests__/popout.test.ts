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

import { test, expect } from "@nn/test";

const NOTE_TITLE = "Popout note";

test("open a note in a new window", async ({ electronApp, page }) => {
  await page.waitForSelector(".ProseMirror");

  await page.locator(`[data-test-id="create-new-note"]`).click();
  await page.locator(`.active [data-test-id="editor-title"]`).fill(NOTE_TITLE);
  const listItem = page.locator(`[data-test-id="list-item"]`, {
    hasText: NOTE_TITLE
  });
  // wait for the note to get created so no keystrokes are lost while the
  // editor switches over to it
  await listItem.waitFor();
  await page.locator(".active .ProseMirror").click();
  await page.keyboard.type("Typed in the main window.");
  await expect(listItem).toContainText("Typed in the main window.");

  const popoutPromise = electronApp.waitForEvent("window");
  await listItem.click({ button: "right" });
  await page.locator(`[data-test-id="menu-button-openinnewwindow"]`).click();
  const popout = await popoutPromise;

  const popoutEditor = popout.locator(".ProseMirror");
  await expect(popoutEditor).toContainText("Typed in the main window.");
  await expect(popout.locator(`[data-test-id="editor-title"]`)).toHaveValue(
    NOTE_TITLE
  );
  // the popout must only show the note & nothing else from the app
  await expect(popout.locator(`[data-test-id="list-item"]`)).toHaveCount(0);
  await expect(popout.locator(`[data-test-id="create-new-note"]`)).toHaveCount(
    0
  );
  await expect(popout.locator(`[data-test-id="tabs"]`)).toHaveCount(0);
  // and the note is no longer open in the main window
  await expect(page.locator(`[data-test-id="editor-title"]`)).not.toHaveValue(
    NOTE_TITLE
  );

  await popoutEditor.click();
  await popout.keyboard.press("Control+End");
  await popout.keyboard.type(" Edited in the popout.");

  const popoutClosed = popout.waitForEvent("close");
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes("/popout"))
      ?.close();
  });
  await popoutClosed;

  // closing the popout must not close the app or lose any edits
  expect(
    await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )
  ).toBe(1);
  await listItem.click();
  await expect(page.locator(".active .ProseMirror")).toContainText(
    "Typed in the main window. Edited in the popout."
  );
});
