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

const BEGIN_STATEMENT = /^\s*begin\b/i;
// a transaction open for longer than this is assumed to be abandoned (e.g.
// its window crashed) & stops blocking other owners
const DEFAULT_WAIT_TIMEOUT = 30 * 1000;

type TransactionLockOptions = {
  isInTransaction: () => boolean;
  waitTimeout?: number;
};

/**
 * Serializes statements from multiple owners (renderer windows) on a single
 * shared SQLite connection.
 *
 * Each renderer only serializes its own queries, so without this a statement
 * from one window could run inside another window's open transaction (and be
 * committed or rolled back with it) or fail trying to start a nested one.
 * Statements are executed one at a time in arrival order & while an owner has
 * a transaction open, statements from all other owners wait for it to end.
 */
export class TransactionLock {
  private owner?: string;
  private released?: Promise<void>;
  private resolveReleased?: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TransactionLockOptions) {}

  async run<T>(
    owner: string | undefined,
    sql: string,
    execute: () => Promise<T>
  ): Promise<T> {
    if (owner !== undefined) {
      await this.waitForTransaction(owner);
      if (!this.owner && BEGIN_STATEMENT.test(sql)) this.acquire(owner);
    }

    return this.enqueue(async () => {
      try {
        return await execute();
      } finally {
        // the owner's transaction has ended (commit, rollback or failed begin)
        if (this.owner === owner && !this.options.isInTransaction())
          this.release();
      }
    });
  }

  private async waitForTransaction(owner: string) {
    const timeout = this.options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
    const deadline = Date.now() + timeout;
    while (this.owner !== undefined && this.owner !== owner && this.released) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn(
          `Transaction held by ${this.owner} for over ${timeout}ms. Releasing it.`
        );
        this.release();
        return;
      }

      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.released,
        new Promise((resolve) => (timer = setTimeout(resolve, remaining)))
      ]);
      clearTimeout(timer);
    }
  }

  private acquire(owner: string) {
    this.owner = owner;
    this.released = new Promise((resolve) => (this.resolveReleased = resolve));
  }

  private release() {
    this.owner = undefined;
    this.resolveReleased?.();
    this.released = undefined;
    this.resolveReleased = undefined;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
