import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Owner } from './domain.js';

/** Legacy settings belong only to Rodion. Never silently share applications. */
export async function loadEnableBankingCredentials(
  env: NodeJS.ProcessEnv,
  owner: Owner,
): Promise<{ applicationId: string; privateKey: string } | undefined> {
  if (owner !== 'rodion' && owner !== 'katya')
    throw new Error('enablebanking_credentials');
  const prefix = `ENABLEBANKING_${owner.toUpperCase()}`;
  const explicit =
    env[`${prefix}_APPLICATION_ID`] !== undefined ||
    env[`${prefix}_PRIVATE_KEY_FILE`] !== undefined;
  const applicationId = explicit
    ? env[`${prefix}_APPLICATION_ID`]
    : owner === 'rodion'
      ? env.ENABLEBANKING_APPLICATION_ID
      : undefined;
  const path = explicit
    ? env[`${prefix}_PRIVATE_KEY_FILE`]
    : owner === 'rodion'
      ? (env.ENABLEBANKING_PRIVATE_KEY_FILE ??
        (applicationId && env.CREDENTIALS_DIRECTORY
          ? resolve(env.CREDENTIALS_DIRECTORY, 'enablebanking.pem')
          : undefined))
      : undefined;
  if (applicationId === undefined && path === undefined) return undefined;
  if (
    !applicationId?.trim() ||
    applicationId.length > 200 ||
    !path ||
    !isAbsolute(path)
  )
    throw new Error('enablebanking_credentials');
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65536)
        throw new Error();
      const buffer = Buffer.alloc(65537);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 65536) throw new Error();
      const privateKey = buffer.subarray(0, size).toString('utf8').trim();
      if (!privateKey) throw new Error();
      return { applicationId: applicationId.trim(), privateKey };
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('enablebanking_credentials');
  }
}
