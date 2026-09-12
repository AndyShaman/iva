import { resolve } from "node:path";

/** Настройка ASSISTANT_VAULT_DIR: края срезаны, пустое — дефолт установки. */
export function vaultDirSetting(configured: string | undefined): string {
  return configured?.trim() || "vault";
}

/**
 * Канонический каталог вольта — одна формула для authored и operational процессов.
 * Относительный путь считается от базы, абсолютный берётся как задан. `configured`
 * без второго аргумента читается из ASSISTANT_VAULT_DIR процесса; явный `undefined`
 * значит «в окружении не задан», а не «возьми значение процесса».
 */
export function resolveVaultDir(root: string, configured?: string): string {
  const value =
    arguments.length > 1 ? configured : process.env.ASSISTANT_VAULT_DIR;
  return resolve(root, vaultDirSetting(value));
}
