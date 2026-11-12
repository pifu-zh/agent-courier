import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

export function acquireLock(file, { logger } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = readFileSync(file, 'utf8').trim();
          if (current === String(process.pid)) unlinkSync(file);
        } catch {
          // already removed or unreadable
        }
      };
      process.once('exit', release);
      return { file, release };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let pid = 0;
      try {
        pid = Number(readFileSync(file, 'utf8').trim());
      } catch {
        pid = 0;
      }

      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          logger?.error?.('bot.lock_held', { pid, file });
          return null;
        } catch (killError) {
          if (killError.code !== 'ESRCH') {
            logger?.error?.('bot.lock_check_failed', {
              pid,
              message: killError.message,
            });
            return null;
          }
        }
      }

      try {
        unlinkSync(file);
      } catch {
        // another process may have removed it
      }
    }
  }
  logger?.error?.('bot.lock_failed', { file });
  return null;
}
