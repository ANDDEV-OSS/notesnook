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

import { expect, test } from "vitest";
import { TransactionLock } from "./transaction-lock";

/**
 * A fake connection that behaves like SQLite with regards to transactions:
 * nested `begin`s fail & `commit`/`rollback` end the transaction.
 */
function createConnection(waitTimeout?: number) {
  const executed: string[] = [];
  let inTransaction = false;
  const lock = new TransactionLock({
    isInTransaction: () => inTransaction,
    waitTimeout
  });

  function run(owner: string | undefined, sql: string) {
    return lock.run(owner, sql, async () => {
      // statements take some time & yield like real IPC calls would
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (sql === "begin") {
        if (inTransaction)
          throw new Error("cannot start a transaction within a transaction");
        inTransaction = true;
      } else if (sql === "commit" || sql === "rollback") {
        if (!inTransaction) throw new Error("no transaction is active");
        inTransaction = false;
      }
      executed.push(`${owner}: ${sql}`);
    });
  }
  return { run, executed };
}

test("statements from other owners wait for an open transaction", async () => {
  const { run, executed } = createConnection();

  await run("main", "begin");
  const popout = run("popout", "update");
  await run("main", "insert");
  await run("main", "commit");
  await popout;

  expect(executed).toEqual([
    "main: begin",
    "main: insert",
    "main: commit",
    "popout: update"
  ]);
});

test("transactions from different owners don't nest", async () => {
  const { run, executed } = createConnection();

  await run("main", "begin");
  const popout = (async () => {
    await run("popout", "begin");
    await run("popout", "update");
    await run("popout", "commit");
  })();
  await run("main", "insert");
  await run("main", "commit");
  await popout;

  expect(executed).toEqual([
    "main: begin",
    "main: insert",
    "main: commit",
    "popout: begin",
    "popout: update",
    "popout: commit"
  ]);
});

test("statements queued before a transaction begins run before it", async () => {
  const { run, executed } = createConnection();

  const popout = run("popout", "update");
  const main = (async () => {
    await run("main", "begin");
    await run("main", "insert");
    await run("main", "commit");
  })();
  await Promise.all([popout, main]);

  expect(executed).toEqual([
    "popout: update",
    "main: begin",
    "main: insert",
    "main: commit"
  ]);
});

test("rolled back transactions release the lock", async () => {
  const { run, executed } = createConnection();

  await run("main", "begin");
  const popout = run("popout", "update");
  await run("main", "rollback");
  await popout;

  expect(executed).toEqual(["main: begin", "main: rollback", "popout: update"]);
});

test("failed statements don't block other owners", async () => {
  const { run, executed } = createConnection();

  await run("main", "begin");
  await expect(run("main", "commit")).resolves.toBeUndefined();
  // nothing to commit: fails but must not leave the lock held
  await expect(run("main", "commit")).rejects.toThrow(
    "no transaction is active"
  );
  await run("popout", "update");

  expect(executed).toEqual(["main: begin", "main: commit", "popout: update"]);
});

test("abandoned transactions stop blocking after the timeout", async () => {
  const { run, executed } = createConnection(50);

  await run("main", "begin");
  // main never commits (e.g. its window crashed)
  await run("popout", "update");

  expect(executed).toEqual(["main: begin", "popout: update"]);
});

test("statements without an owner are not held back", async () => {
  const { run, executed } = createConnection();

  await run("main", "begin");
  await run(undefined, "select");
  await run("main", "commit");

  expect(executed).toEqual([
    "main: begin",
    "undefined: select",
    "main: commit"
  ]);
});
