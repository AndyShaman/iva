// Хаос-прогон обрыва обновления: вывод старого чекаута (`retireCheckout`) и обновление
// шима (`refreshOwnedShim`). Найдено 2026-09-13 маршрутом pbt/deepseek-4-4 (раунд 4).
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed стоит в имени свойства; при провале fast-check печатает
// `{ seed, path, endOnFailure: true }`, который повторяет прогон байт в байт. Обрыв
// моделируется состоянием на диске, которое остаётся после kill в конкретной точке
// (`rmSync` файла без последующей уборки каталогов; шим, унесённый в каталог-заявку).
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/pbt-deepseek-4-4-2026-09-12.md`.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

// Хук резолвинга идёт первым: модули тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";

const { retireCheckout } = await import("../scripts/update-finish.ts");
const { refreshOwnedShim, shimScript } =
  await import("../scripts/lib/version-layout.ts");

const SEED = 20_260_914;
/** Метка незавершённого вывода: её пишет retireCheckout, пока не дочистил чекаут. */
const RETIRE_MARKER = ".iva-retiring";

/** PID, которого нет: имя каталога-заявки шима несёт pid процесса, сделавшего его. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid ?? 999_999;
}

/** Пути, которые git считает своими в чекауте: их вывод и проверяется. */
const TRACKED = [
  ".gitignore",
  "package.json",
  "install.sh",
  "agent/index.ts",
  "agent/tools/x.ts",
  "bin/iva.mjs",
];
/** Тяжёлые артефакты: не отслеживаются, но выводятся всегда. */
const ARTIFACTS = ["node_modules", ".output"];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-home-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", home, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "pbt@test");
  git("config", "user.name", "pbt");
  writeFileSync(join(home, ".gitignore"), "node_modules\n.output\n");
  writeFileSync(join(home, "package.json"), '{ "name": "iva" }\n');
  writeFileSync(join(home, "install.sh"), "#!/bin/sh\n");
  mkdirSync(join(home, "agent", "tools"), { recursive: true });
  writeFileSync(join(home, "agent", "index.ts"), "export {};\n");
  writeFileSync(join(home, "agent", "tools", "x.ts"), "export {};\n");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "iva.mjs"), "// shim entry\n");
  mkdirSync(join(home, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(home, "node_modules", "dep", "index.js"), "x\n");
  mkdirSync(join(home, ".output"), { recursive: true });
  writeFileSync(join(home, ".output", "server.js"), "x\n");
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "settings.json"), "{}\n");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return home;
}

/** Что осталось от чекаута: имена верхнего уровня, кроме вечного (data/.env). */
function leftovers(home: string): string[] {
  return readdirSync(home)
    .filter(
      (name) => !["data", ".env", "current", "repo", "versions"].includes(name),
    )
    .sort();
}

// НАХОДКА R4-1. `retireCheckout` берёт список своих файлов у git, а `.git` удаляет
// первым среди артефактов. Kill между удалением `.git` и `node_modules` (удаление
// большого каталога - секунды, окно широкое) оставляет чекаут без репозитория: повтор
// возвращает [] (git недоступен) и не трогает ни `node_modules`, ни `.output`.
// Путь `adopt()` (scripts/update-finish.ts) вообще не зовёт вывод, если `.git` исчез, -
// то есть гигабайты тяжёлых артефактов остаются на диске навсегда.
await test("НАХОДКА R4-1: обрыв после удаления .git не оставляет артефакты навсегда", () => {
  const home = makeHome();
  for (const relative of TRACKED) rmSync(join(home, relative), { force: true });
  rmSync(join(home, ".git"), { recursive: true, force: true });
  // Обрыв случился уже после первой метки: так это состояние оставляет код с фиксом.
  writeFileSync(join(home, RETIRE_MARKER), "");

  const removed = retireCheckout(home);
  assert.deepEqual(
    leftovers(home).filter((name) => ARTIFACTS.includes(name)),
    [],
    `после повтора осталось: ${JSON.stringify(removed)}, ${JSON.stringify(leftovers(home))}`,
  );
});

// НАХОДКА R4-2. Уборка каталогов висит на удалении файла: пустые родители подчищаются
// только в конце той же итерации. Kill после `rmSync` последнего файла каталога и до
// прохода по родителям оставляет пустые каталоги; на повторе файлов уже нет
// (`existsSync` → continue), и уборка за ними не запускается - пустые `agent/`,
// `agent/tools/`, `bin/` остаются в удалённом чекауте.
await test("НАХОДКА R4-2: обрыв в середине удаления не оставляет пустые каталоги", () => {
  const home = makeHome();
  for (const relative of TRACKED) rmSync(join(home, relative), { force: true });

  retireCheckout(home);
  assert.deepEqual(
    leftovers(home).filter((name) => name === "agent" || name === "bin"),
    [],
    `пустые каталоги: ${JSON.stringify(leftovers(home))}`,
  );
});

// То же свойством: с какого бы места обрыв ни случился, повтор обязан дочистить.
await test(`НАХОДКА R4-1/R4-2: свойство «повтор после обрыва дочищает чекаут» (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.subarray(TRACKED, { minLength: 0, maxLength: TRACKED.length }),
      (alreadyRemoved) => {
        const home = makeHome();
        for (const relative of alreadyRemoved)
          rmSync(join(home, relative), { force: true });
        // Удаление .git в фиксированном коде идёт последним, поэтому обрыв с уже
        // исчезнувшим .git возможен только при оставленной метке.
        if (alreadyRemoved.includes(".git"))
          writeFileSync(join(home, RETIRE_MARKER), "");
        retireCheckout(home);
        assert.deepEqual(
          leftovers(home),
          [],
          `обрыв на ${JSON.stringify(alreadyRemoved)}`,
        );
        assert.ok(existsSync(join(home, "data", "settings.json")));
        assert.ok(existsSync(join(home, ".env")));
        rmSync(home, { recursive: true, force: true });
        return Promise.resolve();
      },
    ),
    { seed: SEED, numRuns: 12 },
  );
});

// Зелёный control: правленый пользователем файл не выводится ни при каком раскладе.
await test("зелёное: правка пользователя в чекауте переживает вывод", () => {
  const home = makeHome();
  writeFileSync(join(home, "agent", "index.ts"), "// правка пользователя\n");
  const removed = retireCheckout(home);
  assert.ok(existsSync(join(home, "agent", "index.ts")));
  assert.ok(removed.includes("package.json"), JSON.stringify(removed));
});

// НАХОДКА R4-4 (шим). Обрыв между claim (шим унесён в `.iva-shim-refresh-<pid>-<id>`)
// и публикацией нового шима: повтор создаёт шим заново, но каталог-заявка с копией
// прежнего шима остаётся в `~/.local/bin` навсегда - ни один путь её не убирает.
await test("НАХОДКА R4-4: обрыв при обновлении шима не оставляет мусор рядом", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  // Заявка обрыва: имя несёт pid процесса, которого больше нет.
  const claim = join(bin, `.iva-shim-refresh-${deadPid()}-${Date.now()}`);
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });

  const repaired = refreshOwnedShim(
    shim,
    home,
    process.execPath,
    join(home, "data"),
  );
  assert.ok(repaired, "шим обязан восстановиться");
  assert.ok(existsSync(shim));
  assert.deepEqual(
    readdirSync(bin).filter((name) => name.startsWith(".iva-shim-refresh-")),
    [],
    "каталог-заявка остался",
  );
});

// Зелёный control уборки: заявку живого процесса она не трогает (иначе снесла бы
// работу параллельного обновления).
await test("зелёное: заявку живого процесса уборка не трогает", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    assert.ok(child.pid, "нет pid живого процесса");
    const claim = join(bin, `.iva-shim-refresh-${child.pid}-live`);
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });
    refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
    assert.ok(existsSync(claim), "заявка живого процесса удалена");
  } finally {
    child.kill("SIGKILL");
  }
});

// Зелёные controls шима: чужой шим не трогается, чужой файл на месте остаётся.
await test("зелёное: чужой шим не перезаписывается", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  writeFileSync(shim, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, join(home, "data")),
    false,
  );
  assert.match(execFileSync("cat", [shim], { encoding: "utf8" }), /foreign/u);
});
