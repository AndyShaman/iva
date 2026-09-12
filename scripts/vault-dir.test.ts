/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Канонический резолвер каталога вольта: одна формула на все боевые места.
// Значение из окружения срезается по краям, пустое — дефолт установки «vault»,
// результат всегда абсолютный от переданной базы.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveVaultDir, vaultDirSetting } from "@iva/vault-dir";

test("T24: пустое значение даёт дефолт установки", () => {
  assert.equal(vaultDirSetting(""), "vault");
  assert.equal(vaultDirSetting("   "), "vault");
  assert.equal(resolveVaultDir("/srv/iva", ""), "/srv/iva/vault");
  assert.equal(resolveVaultDir("/srv/iva", "   "), "/srv/iva/vault");
});

test("T24: пробелы вокруг значения срезаны", () => {
  assert.equal(resolveVaultDir("/srv/iva", " my vault "), "/srv/iva/my vault");
});

test("T24: абсолютный путь возвращается как есть", () => {
  assert.equal(resolveVaultDir("/srv/iva", "/srv/memory"), "/srv/memory");
});

test("T24: явный undefined не подхватывает ASSISTANT_VAULT_DIR процесса", () => {
  const previous = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = "stale-process-state";
  try {
    assert.equal(resolveVaultDir("/srv/iva", undefined), "/srv/iva/vault");
    assert.equal(resolveVaultDir("/srv/iva"), "/srv/iva/stale-process-state");
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previous;
  }
});
